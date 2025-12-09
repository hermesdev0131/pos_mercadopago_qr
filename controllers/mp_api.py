import json
import logging
import requests

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)

class MPApiController(http.Controller):

    def _get_config(self):
        config = request.env['ir.config_parameter'].sudo()
        return {
            "token": config.get_param("mp_access_token"),
            "public_key": config.get_param("mp_public_key"),
            "client_id": config.get_param("mp_client_id"),
            "client_secret": config.get_param("mp_client_secret"),
        }

    def _create_transaction(self, vals):
        return request.env['mp.transaction'].sudo().create(vals)

    # ------------------------------------------------------------------
    # Create QR payment (called from POS frontend)
    # ------------------------------------------------------------------
    @http.route('/mp/pos/create', type='json', auth='public', csrf=False)
    def create_qr_payment(self, **payload):
        """
        Expected JSON:
        {
            "amount": 123.45,
            "description": "Order XYZ",
            "order_uid": "<pos order uid>"
        }
        """
        cfg = self._get_config()
        if not cfg["token"]:
            return {"status": "error", "details": "Missing MercadoPago Access Token in settings"}

        amount = payload.get("amount")
        description = payload.get("description") or "Odoo POS Order"
        order_uid = payload.get("order_uid") or "POS"

        if not amount:
            return {"status": "error", "details": "Amount is required"}

        # External reference used to correlate MP <-> POS
        external_reference = f"OdooPOS-{order_uid}"

        # TODO: replace this block with real MercadoPago QR API call.
        # Example skeleton:
        # url = "https://api.mercadopago.com/instore/orders/qr/seller/collectors/..."
        # headers = {"Authorization": f"Bearer {cfg['token']}", "Content-Type": "application/json"}
        # body = { ... }
        # res = requests.post(url, json=body, headers=headers)
        # data = res.json()

        # For v1.0, we mock a QR code URL to validate the flow end-to-end.
        fake_payment_id = f"MP_TEST_{order_uid}"
        fake_qr_data = f"https://www.mercadopago.com/qr/{fake_payment_id}"

        mp_tx = self._create_transaction({
            "external_reference": external_reference,
            "mp_payment_id": fake_payment_id,
            "qr_data": fake_qr_data,
            "status": "pending",
            "raw_data": json.dumps({
                "amount": amount,
                "description": description,
                "external_reference": external_reference,
            }),
        })

        _logger.info("Created MercadoPago transaction %s for POS order %s", mp_tx.id, order_uid)

        return {
            "status": "success",
            "payment_id": fake_payment_id,
            "qr_url": fake_qr_data,
            "external_reference": external_reference,
        }

    # ------------------------------------------------------------------
    # Check payment status (polled from POS)
    # ------------------------------------------------------------------
    @http.route('/mp/pos/status', type='json', auth='public', csrf=False)
    def payment_status(self, **payload):
        """
        Expected JSON: {"payment_id": "..."}
        For now, we simulate approval after the first check.
        Later you can replace with real MercadoPago GET /v1/payments/{id}.
        """
        payment_id = payload.get("payment_id")
        if not payment_id:
            return {"status": "error", "details": "payment_id is required"}

        tx = request.env['mp.transaction'].sudo().search([
            ('mp_payment_id', '=', payment_id)
        ], limit=1)

        if not tx:
            return {"status": "error", "details": "Transaction not found"}

        # v1.0 dummy logic: toggle from pending → approved on first query
        if tx.status == "pending":
            tx.status = "approved"

        return {
            "status": "success",
            "payment_status": tx.status,
        }

    # ------------------------------------------------------------------
    # Webhook placeholder (optional)
    # ------------------------------------------------------------------
    @http.route('/mp/pos/webhook', type='json', auth='public', csrf=False)
    def webhook(self, **payload):
        _logger.info("MercadoPago webhook payload: %s", payload)
        return {"status": "ok"}