from odoo import models, api
import requests
import logging
import json
import uuid
import threading
import time
import urllib.parse

_logger = logging.getLogger(__name__)

# ============================================================
# TEST MODE CONFIGURATION
# ============================================================
MP_TEST_MODE = True           # Set to False for real MercadoPago API
MP_AUTO_APPROVE_SECONDS = 10  # Auto-approve test payments after X seconds (0 to disable)

# In-memory storage for test payments (no database needed)
_test_payments = {}


def _auto_approve_payment(payment_id, delay):
    """Background thread to auto-approve a test payment after delay."""
    time.sleep(delay)
    if payment_id in _test_payments and _test_payments[payment_id]["status"] == "pending":
        _test_payments[payment_id]["status"] = "approved"
        _logger.info("[MP TEST] Payment %s AUTO-APPROVED after %s seconds", payment_id, delay)


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
        # TEST MODE: Return fake QR for testing UI (no database)
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
        Uses in-memory storage - no database required.
        """
        global _test_payments
        
        # Generate unique payment ID
        payment_id = f"TEST-{uuid.uuid4().hex[:12].upper()}"
        
        # Generate QR code using free API (URL-encode the data)
        qr_content = f"mp://pay/{payment_id}/{amount}"
        qr_data_encoded = urllib.parse.quote(qr_content, safe='')
        qr_url = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={qr_data_encoded}"
        
        # Store in memory (no database)
        _test_payments[payment_id] = {
            "payment_id": payment_id,
            "amount": amount,
            "description": description,
            "external_reference": pos_client_ref,
            "qr_url": qr_url,
            "status": "pending",
        }
        
        # Auto-approve after delay (for testing)
        if MP_AUTO_APPROVE_SECONDS > 0:
            thread = threading.Thread(
                target=_auto_approve_payment,
                args=(payment_id, MP_AUTO_APPROVE_SECONDS)
            )
            thread.daemon = True
            thread.start()
            _logger.info("[MP TEST] Payment will auto-approve in %s seconds", MP_AUTO_APPROVE_SECONDS)
        
        _logger.info("[MP TEST] Created test payment: %s (in-memory)", payment_id)
        
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
            
            # 5. Log Transaction in database
            try:
                self.env['mp.transaction'].sudo().create({
                    "external_reference": external_reference,
                    "mp_payment_id": data.get("id"),
                    "qr_data": data.get("qr_data"),
                    "status": "pending",
                    "raw_data": json.dumps(data),
                    "amount": amount,
                })
            except Exception as e:
                _logger.warning("[MP] Could not log transaction: %s", e)

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
        global _test_payments
        
        # TEST MODE: Check in-memory storage
        if MP_TEST_MODE and payment_id in _test_payments:
            status = _test_payments[payment_id]["status"]
            _logger.info("[MP TEST] Status for %s: %s", payment_id, status)
            return {"payment_status": status}
        
        # PRODUCTION: Check database
        tx = self.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
        if tx:
            return {"payment_status": tx.status}
        
        # In test mode, if not found, assume pending
        if MP_TEST_MODE and payment_id and payment_id.startswith("TEST-"):
            return {"payment_status": "pending"}
        
        return {"payment_status": "not_found"}

    @api.model
    def cancel_mp_payment(self, payment_id):
        """
        Cancel a pending MercadoPago payment.
        """
        global _test_payments
        
        # TEST MODE: Update in-memory
        if MP_TEST_MODE and payment_id in _test_payments:
            _test_payments[payment_id]["status"] = "cancelled"
            _logger.info("[MP TEST] Payment %s cancelled", payment_id)
            return {"status": "cancelled"}
        
        # PRODUCTION: Update database
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
        Call this from browser console or Odoo shell.
        """
        global _test_payments
        
        if not MP_TEST_MODE:
            return {"status": "error", "details": "Not in test mode"}
        
        if payment_id in _test_payments:
            _test_payments[payment_id]["status"] = "approved"
            _logger.info("[MP TEST] Payment %s APPROVED (simulated)", payment_id)
            return {"status": "approved", "payment_id": payment_id}
        
        return {"status": "not_found", "payment_id": payment_id}

    @api.model
    def list_test_payments(self):
        """
        TEST ONLY: List all pending test payments.
        Useful for debugging.
        """
        global _test_payments
        return {
            "test_mode": MP_TEST_MODE,
            "payments": list(_test_payments.values())
        }
