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
MP_TEST_MODE = False           # Set to False for real MercadoPago API
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
        
        # ============================================================
        # TEST MODE: Return fake QR for testing UI (no database)
        # ============================================================
        if MP_TEST_MODE:
            return self._create_test_payment(amount, description, pos_client_ref)
        
        # ============================================================
        # PRODUCTION MODE: Real MercadoPago API
        # ============================================================
        return self._create_real_payment(amount, description, pos_client_ref, payment_method_id, customer_email)

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

    def _validate_access_token(self, token):
        """
        Validates MercadoPago access token using /users/me API.
        
        Returns:
            dict: {
                "valid": bool,
                "token_type": "test" or "production",
                "user_id": str or None,
                "error": str or None
            }
        """
        url = "https://api.mercadopago.com/users/me"
        headers = {
            "Authorization": f"Bearer {token}",
        }
        
        try:
            response = requests.get(url, headers=headers, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                user_id = data.get("id")
                # Determine token type from response or token prefix
                token_type = "test" if token.startswith("TEST-") else "production"
                
                _logger.info("[MP] Token validated - User ID: %s, Type: %s", user_id, token_type)
                return {
                    "valid": True,
                    "token_type": token_type,
                    "user_id": str(user_id) if user_id else None,
                    "error": None,
                }
            else:
                error_data = response.json() if response.text else {}
                error_msg = error_data.get("message", f"HTTP {response.status_code}")
                _logger.error("[MP] Token validation failed: %s", error_msg)
                return {
                    "valid": False,
                    "token_type": None,
                    "user_id": None,
                    "error": error_msg,
                }
        except Exception as e:
            _logger.error("[MP] Token validation exception: %s", str(e))
            return {
                "valid": False,
                "token_type": None,
                "user_id": None,
                "error": str(e),
            }

    def _create_real_payment(self, amount, description, pos_client_ref, payment_method_id, customer_email=None):
        """
        Creates a real MercadoPago payment via Payments API.
        
        Uses POST /v1/payments endpoint which:
        - Only requires Access Token (no terminal/POS device needed)
        - Returns QR code in point_of_interaction.transaction_data
        - Customer scans QR with MercadoPago app to pay
        
        Args:
            customer_email: Email from POS customer, falls back to generic if not provided
        """
        # 1. Get Access Token from system parameters
        config = self.env['ir.config_parameter'].sudo()
        token = config.get_param("mp_access_token")
        
        # DEBUG: Log token info - REMOVE IN PRODUCTION!
        print("=" * 60)
        print("[MP DEBUG] Access Token from system parameters:")
        print(f"  Key: 'mp_access_token'")
        print(f"  Value: {token}")
        print(f"  Length: {len(token) if token else 0}")
        print("=" * 60)
        
        if token:
            _logger.info("[MP DEBUG] Access Token found (length: %d)", len(token))
        else:
            _logger.error("[MP DEBUG] Access Token NOT FOUND in system parameters")
        
        if not token:
            return {
                "status": "error", 
                "details": "Falta el Access Token de MercadoPago - Configure en Ajustes",
                "debug": {"token_found": False, "token_length": 0}
            }
        
        # Validate token using /users/me API
        token_validation = self._validate_access_token(token)
        if not token_validation.get("valid"):
            _logger.error("[MP] Token validation failed: %s", token_validation.get("error"))
            return {
                "status": "error",
                "details": f"Token inválido: {token_validation.get('error', 'Error desconocido')}",
                "debug": {
                    "token_found": True,
                    "token_length": len(token),
                    "token_preview": f"{token[:15]}...{token[-4:]}" if len(token) > 19 else "too_short",
                    "token_valid": False,
                    "validation_error": token_validation.get("error"),
                }
            }
        
        # Include debug info in response (for browser console)
        token_debug = {
            "token_found": True,
            "token_length": len(token),
            "token_preview": f"{token[:15]}...{token[-4:]}" if len(token) > 19 else "too_short",
            "token_valid": True,
            "token_type": token_validation.get("token_type", "unknown"),
            "user_id": token_validation.get("user_id"),
        }

        # 2. Prepare the Payments API request
        url = "https://api.mercadopago.com/v1/payments"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Idempotency-Key": str(uuid.uuid4()),  # Prevent duplicate payments
        }
        
        # 3. Build payload for QR payment
        # Use customer email if provided, otherwise use generic fallback
        payer_email = customer_email if customer_email else "cliente@example.com"
        _logger.info("[MP] Using payer email: %s (from customer: %s)", payer_email, bool(customer_email))
        
        # payment_method_id determines how customer pays (QR code)
        payload = {
            "transaction_amount": float(amount),
            "description": description or "Venta POS Odoo",
            "external_reference": pos_client_ref,
            "payment_method_id": "pix",  # This triggers QR generation
            "payer": {
                "email": payer_email,
            },
        }

        # 4. Make API request
        try:
            _logger.info("[MP] Creating payment via /v1/payments: amount=%s, ref=%s", amount, pos_client_ref)
            _logger.info("[MP DEBUG] Request URL: %s", url)
            _logger.info("[MP DEBUG] Payload: %s", json.dumps(payload))
            
            response = requests.post(url, json=payload, headers=headers, timeout=30)
            
            _logger.info("[MP] Response status: %s", response.status_code)
            _logger.info("[MP DEBUG] Response body: %s", response.text[:500] if response.text else "empty")
            
            if response.status_code not in (200, 201):
                error_msg = response.text
                try:
                    error_data = response.json()
                    error_msg = error_data.get("message", response.text)
                except:
                    pass
                _logger.error("[MP] API Error: %s", error_msg)
                return {"status": "error", "details": error_msg, "debug": token_debug}

            data = response.json()
            payment_id = data.get("id")
            
            # 5. Extract QR code from response
            # The QR is in point_of_interaction.transaction_data
            qr_data = ""
            qr_base64 = ""
            
            point_of_interaction = data.get("point_of_interaction", {})
            transaction_data = point_of_interaction.get("transaction_data", {})
            
            qr_code = transaction_data.get("qr_code", "")
            qr_base64 = transaction_data.get("qr_code_base64", "")
            
            # Build QR image URL
            if qr_base64:
                # Use base64 data directly as image
                qr_data = f"data:image/png;base64,{qr_base64}"
            elif qr_code:
                # Generate QR image from code content
                qr_encoded = urllib.parse.quote(qr_code, safe='')
                qr_data = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={qr_encoded}"
            else:
                _logger.warning("[MP] No QR data in response: %s", json.dumps(data)[:500])
                return {"status": "error", "details": "No se recibió código QR de MercadoPago"}
            
            _logger.info("[MP] Payment created successfully: id=%s, status=%s", payment_id, data.get("status"))
            
            # 6. Log transaction in database (optional, for tracking)
            try:
            self.env['mp.transaction'].sudo().create({
                    "external_reference": pos_client_ref,
                    "mp_payment_id": str(payment_id),
                    "qr_data": qr_code or qr_base64[:100],
                    "status": data.get("status", "pending"),
                "raw_data": json.dumps(data),
                "amount": amount,
            })
            except Exception as e:
                _logger.warning("[MP] Could not log transaction: %s", e)

            return {
                "status": "success",
                "payment_id": str(payment_id),
                "qr_data": qr_data,
                "mp_status": data.get("status"),
            }

        except requests.exceptions.Timeout:
            _logger.error("[MP] Request timeout")
            return {"status": "error", "details": "Timeout de conexión con MercadoPago"}
        except requests.exceptions.RequestException as e:
            _logger.error("[MP] Request error: %s", str(e))
            return {"status": "error", "details": f"Error de conexión: {str(e)}"}
        except Exception as e:
            _logger.error("[MP] Unexpected error: %s", str(e))
            return {"status": "error", "details": str(e)}

    @api.model
    def check_mp_status(self, payment_id):
        """
        Check status of a payment by polling MercadoPago API.
        
        Uses GET /v1/payments/{id} to get real-time status.
        Status values: pending, approved, rejected, cancelled, in_process
        """
        global _test_payments
        
        # TEST MODE: Check in-memory storage
        if MP_TEST_MODE:
            if payment_id in _test_payments:
                status = _test_payments[payment_id]["status"]
                _logger.info("[MP TEST] Status for %s: %s", payment_id, status)
                return {"payment_status": status}
            if payment_id and payment_id.startswith("TEST-"):
                return {"payment_status": "pending"}
        
        # PRODUCTION: Poll MercadoPago API directly
        config = self.env['ir.config_parameter'].sudo()
        token = config.get_param("mp_access_token")
        
        if not token:
            _logger.warning("[MP] No access token for status check")
            # Fallback to database
        tx = self.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
        if tx:
            return {"payment_status": tx.status}
        return {"payment_status": "not_found"}
        
        # Call MercadoPago API
        url = f"https://api.mercadopago.com/v1/payments/{payment_id}"
        headers = {
            "Authorization": f"Bearer {token}",
        }
        
        try:
            response = requests.get(url, headers=headers, timeout=10)
            
            if response.status_code == 200:
                data = response.json()
                status = data.get("status", "pending")
                status_detail = data.get("status_detail", "")
                
                _logger.info("[MP] Payment %s status: %s (%s)", payment_id, status, status_detail)
                
                # Update local transaction record if exists
                tx = self.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
                if tx and tx.status != status:
                    tx.sudo().write({
                        'status': status,
                        'raw_data': json.dumps(data),
                    })
                
                return {
                    "payment_status": status,
                    "status_detail": status_detail,
                }
            
            elif response.status_code == 404:
                _logger.warning("[MP] Payment %s not found in MercadoPago", payment_id)
                return {"payment_status": "not_found"}
            
            else:
                _logger.error("[MP] Status check error: %s", response.text)
                # Fallback to database
                tx = self.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
                if tx:
                    return {"payment_status": tx.status}
                return {"payment_status": "pending"}
                
        except requests.exceptions.Timeout:
            _logger.warning("[MP] Status check timeout for %s", payment_id)
            return {"payment_status": "pending"}
        except Exception as e:
            _logger.error("[MP] Status check error: %s", str(e))
            return {"payment_status": "pending"}

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
