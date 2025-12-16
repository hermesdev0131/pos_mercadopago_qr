import json
import logging

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class MPWebhook(http.Controller):
    """
    MercadoPago Webhook Handler
    
    Receives payment notifications from MercadoPago and updates transaction status.
    Webhooks are sent by MercadoPago when payment status changes (approved, rejected, etc.)
    """

    @http.route('/mp/pos/webhook', type='json', auth='public', csrf=False, cors='*')
    def webhook(self, **payload):
        """
        Handle MercadoPago webhook notifications.
        
        MercadoPago sends webhooks in different formats:
        1. JSON body with payment data
        2. Query parameters with payment_id
        
        Expected payload structure (varies by notification type):
        {
            "action": "payment.created" | "payment.updated",
            "data": {
                "id": "payment_id"
            }
        }
        
        OR
        
        {
            "type": "payment",
            "data": {
                "id": "payment_id"
            }
        }
        """
        _logger.info("[MP Webhook] Received notification: %s", json.dumps(payload)[:500])
        
        try:
            # Extract payment ID from webhook payload
            payment_id = None
            
            # Try different payload structures
            if "data" in payload:
                data = payload.get("data", {})
                if isinstance(data, dict):
                    payment_id = data.get("id")
                elif isinstance(data, str):
                    # Sometimes data is just the payment ID as string
                    payment_id = data
            
            # Also check direct payment_id
            if not payment_id:
                payment_id = payload.get("payment_id") or payload.get("id")
            
            if not payment_id:
                _logger.warning("[MP Webhook] No payment_id found in payload: %s", payload)
                return {"status": "error", "message": "payment_id not found"}
            
            # Get the controller to check payment status
            from .mp_api import MPApiController
            controller = MPApiController()
            
            # Check current payment status from MercadoPago
            status_result = controller._check_mp_payment_status(payment_id)
            new_status = status_result.get("payment_status", "pending")
            
            _logger.info("[MP Webhook] Payment %s status updated to: %s", payment_id, new_status)
            
            # Update local transaction record
            tx = request.env['mp.transaction'].sudo().search([
                ('mp_payment_id', '=', str(payment_id))
            ], limit=1)
            
            if tx:
                old_status = tx.status
                tx.sudo().write({
                    'status': new_status,
                    'raw_data': json.dumps(payload),  # Store webhook payload
                })
                _logger.info("[MP Webhook] Transaction %s updated: %s -> %s", tx.id, old_status, new_status)
            else:
                _logger.warning("[MP Webhook] Transaction not found for payment_id: %s", payment_id)
                # Optionally create transaction if not found
                # request.env['mp.transaction'].sudo().create({
                #     "mp_payment_id": str(payment_id),
                #     "status": new_status,
                #     "raw_data": json.dumps(payload),
                # })
            
            return {"status": "ok", "payment_id": payment_id, "status": new_status}
            
        except Exception as e:
            _logger.error("[MP Webhook] Error processing webhook: %s", str(e), exc_info=True)
            return {"status": "error", "message": str(e)}

    @http.route('/mp/pos/webhook', type='http', auth='public', csrf=False, methods=['GET', 'POST'], cors='*')
    def webhook_http(self, **kwargs):
        """
        Handle webhook via HTTP (for GET requests or form-encoded POST).
        
        Some MercadoPago configurations send webhooks as HTTP GET with query parameters.
        """
        _logger.info("[MP Webhook HTTP] Received %s request: %s", request.httprequest.method, kwargs)
        
        # Try to get payment_id from query parameters
        payment_id = kwargs.get("payment_id") or kwargs.get("id") or kwargs.get("data_id")
        
        if payment_id:
            # Process same as JSON webhook
            return self.webhook(payment_id=payment_id, **kwargs)
        
        # If no payment_id, return success (MercadoPago may send test pings)
        return request.make_response(json.dumps({"status": "ok"}), headers=[('Content-Type', 'application/json')])

