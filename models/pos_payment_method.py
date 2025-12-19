from odoo import models, api, fields
import requests
import logging
import json
import uuid
import threading
import time
import urllib.parse

_logger = logging.getLogger(__name__)

MP_TEST_MODE = True           # Set to False for real MercadoPago API
MP_AUTO_APPROVE_SECONDS = 10  # Auto-approve test payments after X seconds (0 to disable)

_test_payments = {}


def _auto_approve_payment(payment_id, delay):
    """Background thread to auto-approve a test payment after delay."""
    time.sleep(delay)
    if payment_id in _test_payments and _test_payments[payment_id]["status"] == "pending":
        _test_payments[payment_id]["status"] = "approved"
        _logger.info("[MP TEST] Payment %s AUTO-APPROVED after %s seconds", payment_id, delay)


class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    use_mercadopago_qr = fields.Boolean(
        string='Use MercadoPago QR',
        help='Enable this to use MercadoPago QR integration for this payment method'
    )

    # @api.model
    # def _load_pos_data_fields(self, config_id):
    #     # Odoo 18 uses this method to send data to the Owl frontend
    #     params = super()._load_pos_data_fields(config_id)
    #     params.append('use_mercadopago_qr')
    #     return params

    @api.model
    def create_mp_payment(self, amount, description, pos_client_ref, payment_method_id, customer_email=None):
        """
        Creates the preference/QR in MercadoPago.
        Called from POS via ORM service.
        
        Args:
            amount: Payment amount
            description: Payment description (order name)
            pos_client_ref: External reference for the order
            payment_method_id: ID of the pos.payment.method
            customer_email: Optional customer email from POS partner
        """
        _logger.info("[MP] Creating payment - Amount: %s, Ref: %s, Email: %s", amount, pos_client_ref, customer_email)
        
        if MP_TEST_MODE:
            return self._create_test_payment(amount, description, pos_client_ref)
        
        from ..controllers.mp_api import MPApiController
        
        controller = MPApiController()
        return controller._create_mp_preference(amount, description, pos_client_ref, customer_email)

    def _create_test_payment(self, amount, description, pos_client_ref):
        """
        Creates a fake payment for testing purposes.
        Uses in-memory storage - no database required.
        """
        global _test_payments
        
        payment_id = f"TEST-{uuid.uuid4().hex[:12].upper()}"

        qr_content = f"mp://pay/{payment_id}/{amount}"
        qr_data_encoded = urllib.parse.quote(qr_content, safe='')
        qr_url = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={qr_data_encoded}"
        
        _test_payments[payment_id] = {
            "payment_id": payment_id,
            "amount": amount,
            "description": description,
            "external_reference": pos_client_ref,
            "qr_url": qr_url,
            "status": "pending",
        }
        
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


    @api.model
    def check_mp_status(self, payment_id, external_reference=None):
        """
        Check status of a payment by polling MercadoPago API.
        
        Uses GET /v1/payments/search to find payments by external_reference.
        Status values: pending, approved, rejected, cancelled, in_process
        
        Args:
            payment_id: MercadoPago preference ID
            external_reference: Optional external reference for the order
        """
        global _test_payments
        
        if MP_TEST_MODE:
            if payment_id in _test_payments:
                status = _test_payments[payment_id]["status"]
                _logger.info("[MP TEST] Status for %s: %s", payment_id, status)
                return {"payment_status": status}
            if payment_id and payment_id.startswith("TEST-"):
                return {"payment_status": "pending"}
        
        from ..controllers.mp_api import MPApiController
        
        controller = MPApiController()
        
        # If external_reference not provided, try to get it from transaction
        if not external_reference:
            tx = self.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
            if tx and tx.external_reference:
                external_reference = tx.external_reference
        
        return controller._check_mp_payment_status(payment_id, external_reference)

    @api.model
    def cancel_mp_payment(self, payment_id):
        """
        Cancel a pending MercadoPago payment.
        """
        global _test_payments
        
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
