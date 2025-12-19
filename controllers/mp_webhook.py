import json
import logging
import requests
from datetime import datetime, timedelta

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class MPWebhook(http.Controller):
    """
    MercadoPago Webhook Handler
    
    Receives payment notifications from MercadoPago and updates transaction status.
    Webhooks are sent by MercadoPago when payment status changes (approved, rejected, etc.)
    
    IMPORTANT: MercadoPago sends plain HTTP POST with JSON body, NOT JSON-RPC.
    Therefore we use type='http' and parse the JSON body manually.
    """

    @http.route(
        '/mp/pos/webhook',
        type='http',
        auth='public',
        csrf=False,
        methods=['POST', 'GET'],
        cors='*'
    )
    def webhook(self, **kwargs):
        """
        Handle MercadoPago webhook notifications.
        
        MercadoPago sends webhooks as plain HTTP POST with JSON body:
        {
            "action": "payment.created" | "payment.updated",
            "data": {
                "id": "payment_id"  <-- This is the REAL payment ID, NOT the preference_id
            }
        }
        
        We need to:
        1. Parse the JSON body (not query params)
        2. Extract the payment_id from data.id
        3. Fetch full payment details from MercadoPago API
        4. Use preference_id from the payment response to find our local transaction
        5. Update the transaction status
        """
        
        # 1) Read JSON body (MercadoPago sends plain JSON, not JSON-RPC)
        try:
            payload = request.httprequest.get_json(silent=True) or {}
        except Exception:
            payload = {}

        # Fallback to query params if no JSON body
        if not payload:
            payload = dict(kwargs or {})

        _logger.info("[MP Webhook] payload=%s", json.dumps(payload)[:1000])

        # 2) Extract payment_id from webhook payload
        # MercadoPago sends: {"data": {"id": 123456789}}
        # The "id" here is the PAYMENT ID (not preference_id)
        payment_id = None
        data = payload.get("data")

        if isinstance(data, dict):
            payment_id = data.get("id")
        elif isinstance(data, str):
            payment_id = data

        # Fallback to other possible locations
        payment_id = payment_id or payload.get("id") or payload.get("payment_id")

        if not payment_id:
            _logger.info("[MP Webhook] No payment_id in payload, returning ok (might be a test ping)")
            return request.make_response(
                json.dumps({"ok": True, "ignored": True}),
                headers=[('Content-Type', 'application/json')]
            )

        # 3) Get access token to fetch payment details
        token = request.env['ir.config_parameter'].sudo().get_param("mp_access_token")
        if not token:
            token = request.env['ir.config_parameter'].sudo().get_param("mp.access.token")
        
        if not token:
            _logger.warning("[MP Webhook] Missing access token")
            return request.make_response(
                json.dumps({"ok": False, "error": "no_token"}),
                headers=[('Content-Type', 'application/json')]
            )

        # 4) Fetch full payment details from MercadoPago API
        # This gives us the preference_id, external_reference, and status
        url = f"https://api.mercadopago.com/v1/payments/{payment_id}"
        headers = {"Authorization": f"Bearer {token.strip()}"}
        
        try:
            r = requests.get(url, headers=headers, timeout=20)
        except Exception as e:
            _logger.error("[MP Webhook] Request failed: %s", str(e))
            return request.make_response(
                json.dumps({"ok": False, "error": "request_failed"}),
                headers=[('Content-Type', 'application/json')]
            )

        if r.status_code != 200:
            _logger.warning("[MP Webhook] MP fetch failed %s: %s", r.status_code, r.text[:500])
            return request.make_response(
                json.dumps({"ok": False, "error": "mp_fetch_failed", "status_code": r.status_code}),
                headers=[('Content-Type', 'application/json')]
            )

        payment = r.json()
        status = payment.get("status", "pending")
        preference_id = payment.get("preference_id")
        external_reference = payment.get("external_reference")

        _logger.info(
            "[MP Webhook] Payment %s: status=%s, preference_id=%s, external_ref=%s",
            payment_id, status, preference_id, external_reference
        )

        # 5) Find local transaction
        # We stored preference_id as mp_payment_id when creating the preference
        tx = None
        
        # First try to find by preference_id (what we stored as mp_payment_id)
        if preference_id:
            tx = request.env['mp.transaction'].sudo().search(
                [('mp_payment_id', '=', str(preference_id))],
                limit=1
            )

        # Fallback: find by external_reference
        if not tx and external_reference:
            tx = request.env['mp.transaction'].sudo().search(
                [('external_reference', '=', external_reference)],
                limit=1
            )

        # 6) Update transaction status with safeguards
        if tx:
            old_status = tx.status
            
            # SAFEGUARD 1: Don't update if already in final state
            # This prevents webhooks from old payments overwriting new transactions
            if old_status in ('approved', 'rejected', 'cancelled'):
                _logger.info(
                    "[MP Webhook] Transaction %s already in final state %s, ignoring update to %s",
                    tx.id, old_status, status
                )
                return request.make_response(
                    json.dumps({"ok": True, "ignored": "already_final", "current_status": old_status}),
                    headers=[('Content-Type', 'application/json')]
                )
            
            # SAFEGUARD 2: Only update if transaction is recent (within 30 minutes)
            # This prevents delayed webhooks from previous orders updating new transactions
            # Odoo stores naive datetime in UTC, so we compare with UTC
            from datetime import timezone
            tx_create_date = tx.create_date
            if tx_create_date.tzinfo:
                tx_create_date_utc = tx_create_date.astimezone(timezone.utc)
            else:
                # Assume UTC if naive
                tx_create_date_utc = tx_create_date.replace(tzinfo=timezone.utc)
            
            now_utc = datetime.now(timezone.utc)
            age_minutes = (now_utc - tx_create_date_utc).total_seconds() / 60
            
            if age_minutes > 30:
                _logger.warning(
                    "[MP Webhook] Transaction %s is too old (%.1f minutes), ignoring update. "
                    "This prevents old webhooks from affecting new transactions.",
                    tx.id, age_minutes
                )
                return request.make_response(
                    json.dumps({"ok": True, "ignored": "too_old", "age_minutes": age_minutes}),
                    headers=[('Content-Type', 'application/json')]
                )
            
            # SAFEGUARD 3: Only update if current status is "initial" or "pending"
            # This ensures we only update transactions that are still waiting for payment
            if old_status not in ('initial', 'pending'):
                _logger.info(
                    "[MP Webhook] Transaction %s has status %s (not initial/pending), ignoring update to %s",
                    tx.id, old_status, status
                )
                return request.make_response(
                    json.dumps({"ok": True, "ignored": "invalid_state", "current_status": old_status}),
                    headers=[('Content-Type', 'application/json')]
                )
            
            # All safeguards passed - safe to update
            tx.sudo().write({
                "status": status,
                "raw_data": json.dumps(payment),
            })
            _logger.info("[MP Webhook] Transaction %s updated: %s -> %s", tx.id, old_status, status)
        else:
            _logger.warning(
                "[MP Webhook] No transaction found for payment_id=%s pref=%s ext_ref=%s",
                payment_id, preference_id, external_reference
            )

        return request.make_response(
            json.dumps({"ok": True, "status": status}),
            headers=[('Content-Type', 'application/json')]
        )
