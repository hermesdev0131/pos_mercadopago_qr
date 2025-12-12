from odoo import models, api
import requests
import logging
import json
import uuid

_logger = logging.getLogger(__name__)

# ============================================================
# TEST MODE: Set to True to use fake QR codes for testing
# Set to False when ready to use real MercadoPago API
# ============================================================
MP_TEST_MODE = True


class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    @api.model
    def create_mp_payment(self, amount, description, pos_client_ref, payment_method_id):
        """
        Creates the preference/QR in MercadoPago.
        Called from POS via ORM service.
        """
        _logger.info("[MP] Creating payment - Amount: %s, Ref: %s", amount, pos_client_ref)
        
        # ============================================================
        # TEST MODE: Return fake QR for testing UI
        # ============================================================
        if MP_TEST_MODE:
            return self._create_test_payment(amount, description, pos_client_ref)
        
        # ============================================================
        # PRODUCTION MODE: Real MercadoPago API
        # ============================================================
        return self._create_real_payment(amount, description, pos_client_ref, payment_method_id)

    def _create_test_payment(self, amount, description, pos_client_ref):
        """
        Creates a fake payment for testing purposes.
        Returns a generated QR code image.
        """
        # Generate unique payment ID
        payment_id = f"TEST-{uuid.uuid4().hex[:12].upper()}"
        
        # Generate QR code using free API (encodes the payment info)
        qr_content = f"mercadopago://pay?amount={amount}&ref={pos_client_ref}"
        qr_url = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={qr_content}"
        
        # Log test transaction
        try:
            self.env['mp.transaction'].sudo().create({
                "external_reference": pos_client_ref,
                "mp_payment_id": payment_id,
                "qr_data": qr_url,
                "status": "pending",
                "raw_data": json.dumps({
                    "test_mode": True,
                    "amount": amount,
                    "description": description,
                }),
                "amount": amount,
            })
        except Exception as e:
            _logger.warning("[MP TEST] Could not create transaction record: %s", e)
        
        _logger.info("[MP TEST] Created test payment: %s", payment_id)
        
        return {
            "status": "success",
            "payment_id": payment_id,
            "qr_data": qr_url,
        }

    def _create_real_payment(self, amount, description, pos_client_ref, payment_method_id):
        """
        Creates a real MercadoPago payment via API.
        """
        # 1. Get the specific payment method record to access credentials
        pm = self.browse(payment_method_id)
        
        # 2. Get tokens from config
        config = self.env['ir.config_parameter'].sudo()
        token = config.get_param("mp_access_token")
        
        if not token:
            return {"status": "error", "details": "Missing MP Token - Configure in Settings"}

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
            "notification_url": "https://your-server.com/mp/webhook",
        }

        # 4. Request to MP
        try:
            _logger.info("[MP] Creating QR: %s", payload)
            response = requests.post(url, json=payload, headers=headers)
            
            if response.status_code not in (200, 201):
                _logger.error("[MP] API Error: %s", response.text)
                return {"status": "error", "details": response.text}

            data = response.json()
            
            # 5. Log Transaction
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

    @api.model
    def simulate_mp_approval(self, payment_id):
        """
        TEST ONLY: Simulate payment approval for testing.
        Call this method to approve a pending test payment.
        """
        if not MP_TEST_MODE:
            return {"status": "error", "details": "Not in test mode"}
        
        tx = self.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
        if tx and tx.status == 'pending':
            tx.write({'status': 'approved'})
            _logger.info("[MP TEST] Payment %s approved (simulated)", payment_id)
            return {"status": "approved"}
        return {"status": "not_found"}
