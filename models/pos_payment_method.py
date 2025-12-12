from odoo import models, api
import requests
import logging
import json

_logger = logging.getLogger(__name__)

class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    @api.model
    def create_mp_payment(self, amount, description, pos_client_ref, payment_method_id):
        """
        Creates the preference/QR in MercadoPago.
        Called from POS via ORM service.
        """
        # 1. Get the specific payment method record to access credentials
        pm = self.browse(payment_method_id)
        
        # 2. Get tokens (assuming you store them on the payment method or config)
        # Note: If credentials are in res.config.settings, fetch them like before:
        config = self.env['ir.config_parameter'].sudo()
        token = config.get_param("mp_access_token")
        
        if not token:
            return {"status": "error", "details": "Missing MP Token"}

        # 3. Prepare Payload
        external_reference = pos_client_ref
        url = "https://api.mercadopago.com/instore/orders/qr/seller/collectors"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }
        payload = {
            "amount": amount,
            "description": description,
            "external_reference": external_reference,
            "notification_url": "https://your-server.com/mp/webhook", # Optional
        }

        # 4. Request to MP
        try:
            _logger.info("[MP] Creating QR: %s", payload)
            response = requests.post(url, json=payload, headers=headers)
            
            if response.status_code not in (200, 201):
                return {"status": "error", "details": response.text}

            data = response.json()
            
            # 5. Log Transaction (using your existing mp.transaction model)
            self.env['mp.transaction'].sudo().create({
                "external_reference": external_reference,
                "mp_payment_id": data.get("id"),
                "qr_data": data.get("qr_data"),
                "status": "pending",
                "raw_data": json.dumps(data),
                "amount": amount,
            })

            return {
                "status": "success",
                "payment_id": data.get("id"),
                "qr_data": data.get("qr_data"),
            }

        except Exception as e:
            _logger.error("MP Error: %s", str(e))
            return {"status": "error", "details": str(e)}

    @api.model
    def check_mp_status(self, payment_id):
        """
        Check status of a payment.
        """
        # Logic to check status in your mp.transaction table
        tx = self.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
        if tx:
            return {"payment_status": tx.status}
        return {"payment_status": "not_found"}

    @api.model
    def cancel_mp_payment(self, payment_id):
        """
        Cancel a pending MercadoPago payment.
        """
        tx = self.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
        if tx and tx.status == 'pending':
            tx.write({'status': 'cancelled'})
            _logger.info("[MP] Payment %s cancelled", payment_id)
            return {"status": "cancelled"}
        return {"status": "not_found"}