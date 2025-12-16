import json
import logging
import requests
import urllib.parse
import uuid

from odoo import http
from odoo.http import request

_logger = logging.getLogger(__name__)


class MPApiController(http.Controller):
    """
    MercadoPago API Controller for POS integration.
    
    Provides helper methods for MercadoPago API calls that can be used by:
    - Model methods (via delegation)
    - HTTP routes (for external access)
    - Webhook handlers
    """

    def _get_access_token(self):
        """
        Get MercadoPago Access Token from system parameters.
        Supports both naming conventions: mp_access_token and mp.access.token
        """
        config = request.env['ir.config_parameter'].sudo()
        token_raw = config.get_param("mp_access_token") or config.get_param("mp.access.token")
        # Strip whitespace (common issue - tokens copied with extra spaces)
        return token_raw.strip() if token_raw else None

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

    def _create_mp_preference(self, amount, description, external_reference, customer_email=None):
        """
        Creates a MercadoPago Checkout Preference and returns QR code.
        
        Uses POST /checkout/preferences endpoint which:
        - Only requires Access Token (no terminal/POS device needed)
        - Returns QR code in preference response (qr_code or qr_code_base64)
        - Uses items array with category_id for better approval rates
        - Customer scans QR with MercadoPago app to pay
        
        Args:
            amount: Payment amount (float)
            description: Payment description (order name)
            external_reference: External reference for the order
            customer_email: Optional customer email from POS partner
        
        Returns:
            dict: {
                "status": "success" or "error",
                "payment_id": str (preference ID),
                "qr_data": str (QR image URL or base64),
                "details": str (error message if status="error"),
                "debug": dict (debug info for browser console)
            }
        """
        # 1. Get Access Token
        token = self._get_access_token()
        
        # DEBUG: Log token info
        if token:
            _logger.info("[MP DEBUG] Access Token found (length: %d, starts with: %s)", 
                        len(token), token[:10] if len(token) >= 10 else token)
            
            # Verify it's an ACCESS_TOKEN, not a PUBLIC_KEY
            if token.startswith("APP_USR-") or token.startswith("TEST-"):
                _logger.info("[MP DEBUG] Token format: ACCESS_TOKEN (correct)")
            elif token.startswith("APP_") and len(token) < 50:
                _logger.warning("[MP DEBUG] Token might be PUBLIC_KEY (too short for ACCESS_TOKEN)")
            else:
                _logger.warning("[MP DEBUG] Token format unknown - might be invalid")
        else:
            _logger.error("[MP DEBUG] Access Token NOT FOUND in system parameters")
        
        if not token:
            return {
                "status": "error", 
                "details": "Falta el Access Token de MercadoPago - Configure en Ajustes",
                "debug": {"token_found": False, "token_length": 0}
            }
        
        # 2. Validate token
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

        # 3. Verify token is ACCESS_TOKEN, not PUBLIC_KEY
        if token and len(token) < 50 and token.startswith("APP_"):
            _logger.error("[MP] ERROR: Token appears to be PUBLIC_KEY, not ACCESS_TOKEN!")
            return {
                "status": "error",
                "details": "Error: Se está usando PUBLIC_KEY en lugar de ACCESS_TOKEN. Use el ACCESS_TOKEN (más largo) para llamadas API.",
                "debug": {
                    "token_found": True,
                    "token_length": len(token),
                    "token_type": "PUBLIC_KEY (incorrecto)",
                }
            }
        
        # 4. Prepare the Checkout Preferences API request
        url = "https://api.mercadopago.com/checkout/preferences"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
        }
        
        # 5. Build payload for Checkout Preferences
        # Using items array with category_id for better approval rates (reduces fraud warnings)
        payload = {
            "items": [{
                "title": description or "Venta POS Odoo",
                "quantity": 1,
                "unit_price": float(amount),
                "currency_id": "ARS",  # Argentina Peso
                "category_id": "services",  # Reduces fraud detection false positives
            }],
            "external_reference": external_reference,
            # Configure payment methods to enable QR payments
            "payment_methods": {
                "excluded_payment_methods": [],
                "excluded_payment_types": [],
                "installments": 1,  # Single payment (no installments for QR)
            },
            # Force QR payment type if available
            # Note: Some regions use "pix" for QR, others use "qr_code"
            "payment_type_id": "qr_code",  # Try QR code payment type
        }
        
        # 6. Make API request
        try:
            _logger.info("[MP] Creating preference via /checkout/preferences: amount=%s, ref=%s", amount, external_reference)
            _logger.info("[MP DEBUG] Request URL: %s", url)
            _logger.info("[MP DEBUG] Payload: %s", json.dumps(payload))
            
            response = requests.post(url, json=payload, headers=headers, timeout=30)
            
            _logger.info("[MP] Response status: %s", response.status_code)
            
            # Parse response
            try:
                data = response.json()
                # Log full response structure for debugging
                _logger.info("[MP DEBUG] Full response structure: %s", json.dumps(data, indent=2)[:2000])
                _logger.info("[MP DEBUG] Response keys: %s", list(data.keys()) if isinstance(data, dict) else "Not a dict")
            except Exception:
                data = {"raw": response.text}
                _logger.warning("[MP DEBUG] Could not parse JSON response: %s", response.text[:500])
            
            # Enhanced error handling matching working implementation
            if response.status_code == 401:
                error_msg = "Mercado Pago rejected the token (401 unauthorized). Verify you're using the private ACCESS_TOKEN (not the public key), and that it's correct for your environment (test vs production)."
                _logger.error("[MP] 401 Unauthorized: %s", error_msg)
                return {
                    "status": "error",
                    "error": "unauthorized",
                    "details": error_msg,
                    "mp_response": data,
                    "debug": token_debug
                }
            
            if response.status_code >= 400:
                error_msg = data.get("message", response.text) if isinstance(data, dict) else response.text
                _logger.error("[MP] API Error [%s]: %s", response.status_code, error_msg)
                return {
                    "status": "error",
                    "error": "mp_error",
                    "error_code": response.status_code,
                    "details": error_msg,
                    "mp_response": data,
                    "debug": token_debug
                }

            # 7. Extract QR code from preference response
            preference_id = data.get("id")
            qr_data = ""
            
            # Try to get QR code from preference response (check all possible locations)
            qr_code = data.get("qr_code", "")
            qr_code_base64 = data.get("qr_code_base64", "")
            
            # Check in point_of_interaction if present (some responses structure it there)
            point_of_interaction = data.get("point_of_interaction", {})
            if point_of_interaction:
                transaction_data = point_of_interaction.get("transaction_data", {})
                if transaction_data:
                    qr_code = qr_code or transaction_data.get("qr_code", "")
                    qr_code_base64 = qr_code_base64 or transaction_data.get("qr_code_base64", "")
            
            # Also check in payment_methods array if present
            payment_methods = data.get("payment_methods", [])
            if payment_methods and isinstance(payment_methods, list):
                for pm in payment_methods:
                    if isinstance(pm, dict):
                        qr_code = qr_code or pm.get("qr_code", "")
                        qr_code_base64 = qr_code_base64 or pm.get("qr_code_base64", "")
            
            # Build QR image URL
            if qr_code_base64:
                # Use base64 data directly as image
                qr_data = f"data:image/png;base64,{qr_code_base64}"
                _logger.info("[MP] Found QR code (base64) in preference response")
            elif qr_code:
                # Generate QR image from code content
                qr_encoded = urllib.parse.quote(qr_code, safe='')
                qr_data = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={qr_encoded}"
                _logger.info("[MP] Found QR code (text) in preference response")
            else:
                # If no QR in preference, try fallback to /v1/payments API
                _logger.warning("[MP] No QR data in preference response. Trying fallback to /v1/payments API...")
                _logger.info("[MP] Preference ID: %s", preference_id)
                _logger.debug("[MP] Full preference response: %s", json.dumps(data, indent=2)[:1000])
                
                # Fallback: Create payment directly via /v1/payments
                return self._create_mp_payment_fallback(amount, description, external_reference, customer_email, token, token_debug, preference_id)
            
            _logger.info("[MP] Preference created successfully: id=%s", preference_id)
            
            # 8. Log transaction in database (optional, for tracking)
            try:
                request.env['mp.transaction'].sudo().create({
                    "external_reference": external_reference,
                    "mp_payment_id": str(preference_id),  # Store preference ID
                    "qr_data": qr_code or qr_code_base64[:100] if qr_code_base64 else "",
                    "status": "pending",
                    "raw_data": json.dumps(data),
                    "amount": amount,
                })
            except Exception as e:
                _logger.warning("[MP] Could not log transaction: %s", e)

            return {
                "status": "success",
                "payment_id": str(preference_id),  # Return preference ID for status checking
                "qr_data": qr_data,
                "preference_id": preference_id,
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

    def _create_mp_payment_fallback(self, amount, description, external_reference, customer_email, token, token_debug, preference_id=None):
        """
        Fallback method: Create payment directly via /v1/payments API.
        
        This is used when Checkout Preferences doesn't return a QR code.
        The /v1/payments API directly creates QR payments and returns QR in response.
        
        Args:
            amount: Payment amount
            description: Payment description
            external_reference: External reference
            customer_email: Customer email
            token: Access token
            token_debug: Debug info
            preference_id: Optional preference ID (if preference was created)
        
        Returns:
            dict: Same format as _create_mp_preference
        """
        _logger.info("[MP] Using fallback: Creating payment via /v1/payments API")
        
        url = "https://api.mercadopago.com/v1/payments"
        headers = {
            "Content-Type": "application/json",
            "Authorization": f"Bearer {token}",
            "X-Idempotency-Key": str(uuid.uuid4()),  # Prevent duplicate payments
        }
        
        # Use customer email if provided, otherwise use generic fallback
        payer_email = customer_email if customer_email else "cliente@example.com"
        _logger.info("[MP] Using payer email: %s (from customer: %s)", payer_email, bool(customer_email))
        
        # Build payload for direct payment creation with QR
        payload = {
            "transaction_amount": float(amount),
            "description": description or "Venta POS Odoo",
            "external_reference": external_reference,
            "payment_method_id": "pix",  # PIX/QR payment method (works for Argentina and Brazil)
            "payer": {
                "email": payer_email,
            },
        }
        
        try:
            _logger.info("[MP] Creating payment via /v1/payments: amount=%s, ref=%s", amount, external_reference)
            _logger.info("[MP DEBUG] Request URL: %s", url)
            _logger.info("[MP DEBUG] Payload: %s", json.dumps(payload))
            
            response = requests.post(url, json=payload, headers=headers, timeout=30)
            
            _logger.info("[MP] Response status: %s", response.status_code)
            
            # Parse response
            try:
                data = response.json()
                _logger.info("[MP DEBUG] Full payment response: %s", json.dumps(data, indent=2)[:2000])
            except Exception:
                data = {"raw": response.text}
            
            if response.status_code == 401:
                error_msg = "Mercado Pago rejected the token (401 unauthorized). Verify you're using the private ACCESS_TOKEN (not the public key), and that it's correct for your environment (test vs production)."
                _logger.error("[MP] 401 Unauthorized: %s", error_msg)
                return {
                    "status": "error",
                    "error": "unauthorized",
                    "details": error_msg,
                    "mp_response": data,
                    "debug": token_debug
                }
            
            if response.status_code >= 400:
                error_msg = data.get("message", response.text) if isinstance(data, dict) else response.text
                _logger.error("[MP] API Error [%s]: %s", response.status_code, error_msg)
                return {
                    "status": "error",
                    "error": "mp_error",
                    "error_code": response.status_code,
                    "details": error_msg,
                    "mp_response": data,
                    "debug": token_debug
                }
            
            # Extract payment ID and QR code
            payment_id = data.get("id")
            qr_data = ""
            
            # QR is in point_of_interaction.transaction_data
            point_of_interaction = data.get("point_of_interaction", {})
            transaction_data = point_of_interaction.get("transaction_data", {}) if point_of_interaction else {}
            
            qr_code = transaction_data.get("qr_code", "")
            qr_code_base64 = transaction_data.get("qr_code_base64", "")
            
            # Build QR image URL
            if qr_code_base64:
                qr_data = f"data:image/png;base64,{qr_code_base64}"
                _logger.info("[MP] Found QR code (base64) in payment response")
            elif qr_code:
                qr_encoded = urllib.parse.quote(qr_code, safe='')
                qr_data = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={qr_encoded}"
                _logger.info("[MP] Found QR code (text) in payment response")
            else:
                _logger.error("[MP] No QR data in payment response either!")
                return {
                    "status": "error",
                    "details": f"No se pudo generar código QR. Preference ID: {preference_id or 'N/A'}, Payment ID: {payment_id or 'N/A'}. Verifique la configuración de métodos de pago en MercadoPago.",
                    "preference_id": preference_id,
                    "payment_id": payment_id,
                }
            
            _logger.info("[MP] Payment created successfully via fallback: id=%s", payment_id)
            
            # Log transaction in database
            try:
                request.env['mp.transaction'].sudo().create({
                    "external_reference": external_reference,
                    "mp_payment_id": str(payment_id),
                    "qr_data": qr_code or qr_code_base64[:100] if qr_code_base64 else "",
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
                "preference_id": preference_id,  # Include preference_id if it was created
            }
            
        except requests.exceptions.Timeout:
            _logger.error("[MP] Fallback request timeout")
            return {"status": "error", "details": "Timeout de conexión con MercadoPago"}
        except requests.exceptions.RequestException as e:
            _logger.error("[MP] Fallback request error: %s", str(e))
            return {"status": "error", "details": f"Error de conexión: {str(e)}"}
        except Exception as e:
            _logger.error("[MP] Fallback unexpected error: %s", str(e))
            return {"status": "error", "details": str(e)}

    def _check_mp_payment_status(self, payment_id):
        """
        Check status of a payment by polling MercadoPago API.
        
        Uses GET /v1/payments/{id} to get real-time status.
        Status values: pending, approved, rejected, cancelled, in_process
        
        Args:
            payment_id: MercadoPago payment/preference ID
        
        Returns:
            dict: {
                "payment_status": str (pending, approved, rejected, etc.),
                "status_detail": str (optional detail)
            }
        """
        # Get Access Token
        token = self._get_access_token()
        
        if not token:
            _logger.warning("[MP] No access token for status check")
            # Fallback to database
            tx = request.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
            if tx:
                return {"payment_status": tx.status}
            return {"payment_status": "not_found"}
        
        # Call MercadoPago API
        url = f"https://api.mercadopago.com/v1/payments/{payment_id}"
        headers = {
            "Authorization": f"Bearer {token}",
        }
        
        try:
            response = requests.get(url, headers=headers, timeout=20)
            
            # Parse response
            try:
                data = response.json()
            except Exception:
                data = {"raw": response.text}
            
            if response.status_code == 200:
                status = data.get("status", "pending")
                status_detail = data.get("status_detail", "")
                
                _logger.info("[MP] Payment %s status: %s (%s)", payment_id, status, status_detail)
                
                # Update local transaction record if exists
                tx = request.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
                if tx and tx.status != status:
                    tx.sudo().write({
                        'status': status,
                        'raw_data': json.dumps(data),
                    })
                
                return {
                    "payment_status": status,
                    "status_detail": status_detail,
                }
            
            elif response.status_code == 401:
                _logger.error("[MP] 401 Unauthorized when checking payment status")
                # Fallback to database
                tx = request.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
                if tx:
                    return {"payment_status": tx.status}
                return {"payment_status": "pending"}
            
            elif response.status_code == 404:
                _logger.warning("[MP] Payment %s not found in MercadoPago", payment_id)
                return {"payment_status": "not_found"}
            
            elif response.status_code >= 400:
                _logger.error("[MP] Status check error [%s]: %s", response.status_code, response.text)
                # Fallback to database
                tx = request.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
                if tx:
                    return {"payment_status": tx.status}
                return {"payment_status": "pending"}
                
        except requests.exceptions.Timeout:
            _logger.warning("[MP] Status check timeout for %s", payment_id)
            return {"payment_status": "pending"}
        except Exception as e:
            _logger.error("[MP] Status check error: %s", str(e))
            return {"payment_status": "pending"}

    # ------------------------------------------------------------------
    # HTTP Routes (optional - for external access or webhooks)
    # ------------------------------------------------------------------

    @http.route('/mp/pos/create_preference', type='json', auth='user', csrf=False)
    def create_preference_http(self, **kwargs):
        """
        HTTP endpoint for creating MercadoPago preference.
        Can be called from external systems or for testing.
        """
        amount = kwargs.get("amount", 0)
        description = kwargs.get("description") or "Odoo POS Order"
        external_reference = kwargs.get("external_reference") or kwargs.get("order_uid", "POS")
        customer_email = kwargs.get("customer_email")
        
        if not amount:
            return {"ok": False, "error": "missing_amount", "message": "Amount is required"}
        
        result = self._create_mp_preference(amount, description, external_reference, customer_email)
        
        if result.get("status") == "success":
            return {
                "ok": True,
                "preference": {
                    "id": result.get("payment_id"),
                    "qr_code": result.get("qr_data"),
                }
            }
        else:
            return {
                "ok": False,
                "error": result.get("error", "mp_error"),
                "message": result.get("details", "Unknown error"),
                "mp_response": result.get("mp_response"),
            }

    @http.route('/mp/pos/payment_status', type='json', auth='user', csrf=False)
    def payment_status_http(self, payment_id=None, **kwargs):
        """
        HTTP endpoint for checking payment status.
        Can be called from external systems or for testing.
        """
        if not payment_id:
            payment_id = kwargs.get("payment_id")
        
        if not payment_id:
            return {"ok": False, "error": "missing_payment_id", "message": "payment_id is required"}
        
        result = self._check_mp_payment_status(payment_id)
        
        return {
            "ok": True,
            "payment": {
                "status": result.get("payment_status"),
                "status_detail": result.get("status_detail"),
            }
        }
