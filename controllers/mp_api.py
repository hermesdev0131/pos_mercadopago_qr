import json
import requests
import urllib.parse

from odoo import http
from odoo.http import request


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
                token_type = "test" if token.startswith("TEST-") else "production"
                
                return {
                    "valid": True,
                    "token_type": token_type,
                    "user_id": str(user_id) if user_id else None,
                    "error": None,
                }
            else:
                error_data = response.json() if response.text else {}
                error_msg = error_data.get("message", f"HTTP {response.status_code}")
                return {
                    "valid": False,
                    "token_type": None,
                    "user_id": None,
                    "error": error_msg,
                }
        except Exception as e:
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
                "details": str (error message if status="error")
            }
        """
        # 1. Get Access Token
        token = self._get_access_token()
        
        if not token:
            return {
                "status": "error", 
                "details": "Falta el Access Token de MercadoPago - Configure en Ajustes",
            }
        
        # 2. Validate token
        token_validation = self._validate_access_token(token)
        if not token_validation.get("valid"):
            return {
                "status": "error",
                "details": f"Token inválido: {token_validation.get('error', 'Error desconocido')}",
            }
        
        # 3. Verify token is ACCESS_TOKEN, not PUBLIC_KEY
        if token and len(token) < 50 and token.startswith("APP_"):
            return {
                "status": "error",
                "details": "Error: Se está usando PUBLIC_KEY en lugar de ACCESS_TOKEN. Use el ACCESS_TOKEN (más largo) para llamadas API.",
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
        }
        
        # 6. Make API request
        try:
            
            response = requests.post(url, json=payload, headers=headers, timeout=30)
            
            try:
                data = response.json()
            except Exception:
                data = {"raw": response.text}
            
            if response.status_code == 401:
                return {
                    "status": "error",
                    "error": "unauthorized",
                    "details": "Mercado Pago rechazó el token (401). Verifique que está usando ACCESS_TOKEN (no PUBLIC_KEY) y que es correcto para su ambiente (test vs producción).",
                }
            
            if response.status_code >= 400:
                error_msg = data.get("message", response.text) if isinstance(data, dict) else response.text
                return {
                    "status": "error",
                    "error": "mp_error",
                    "error_code": response.status_code,
                    "details": error_msg,
                }

            # 7. Extract QR code from preference response
            preference_id = data.get("id")
            qr_data = ""
            
            # Try to get QR code from preference response - check all possible locations
            
            # 1. Check root level qr_code_base64 and qr_code
            qr_code_base64 = data.get("qr_code_base64", "")
            qr_code = data.get("qr_code", "")
            
            # 2. Check in point_of_interaction.transaction_data
            point_of_interaction = data.get("point_of_interaction", {})
            if point_of_interaction:
                transaction_data = point_of_interaction.get("transaction_data", {})
                if transaction_data:
                    if not qr_code_base64:
                        qr_code_base64 = transaction_data.get("qr_code_base64", "")
                    if not qr_code:
                        qr_code = transaction_data.get("qr_code", "")
            
            # 3. Check init_point (payment link) - can be converted to QR
            init_point = data.get("init_point", "")
            sandbox_init_point = data.get("sandbox_init_point", "")  # For test mode
            
            # Build QR image URL - try in order of preference
            if qr_code_base64:
                qr_data = f"data:image/png;base64,{qr_code_base64}"
            elif qr_code:
                qr_encoded = urllib.parse.quote(qr_code, safe='')
                qr_data = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={qr_encoded}"
            elif init_point:
                qr_encoded = urllib.parse.quote(init_point, safe='')
                qr_data = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={qr_encoded}"
            elif sandbox_init_point:
                qr_encoded = urllib.parse.quote(sandbox_init_point, safe='')
                qr_data = f"https://api.qrserver.com/v1/create-qr-code/?size=300x300&data={qr_encoded}"
            else:
                return {
                    "status": "error", 
                    "details": "Preferencia creada pero no se recibió código QR ni enlace de pago. Verifique la configuración de métodos de pago en MercadoPago.",
                    "preference_id": preference_id
                }
            
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
                pass  

            return {
                "status": "success",
                "payment_id": str(preference_id),  # Return preference ID for status checking
                "qr_data": qr_data,
                "preference_id": preference_id,
            }

        except requests.exceptions.Timeout:
            return {"status": "error", "details": "Timeout de conexión con MercadoPago"}
        except requests.exceptions.RequestException as e:
            return {"status": "error", "details": f"Error de conexión: {str(e)}"}
        except Exception as e:
            return {"status": "error", "details": str(e)}

    def _check_mp_payment_status(self, payment_id, external_reference=None):
        """
        Check status of a payment by polling MercadoPago API.
        
        Uses GET /v1/payments/search to find payments by external_reference.
        This is the recommended approach when using Checkout Preferences.
        
        Args:
            payment_id: MercadoPago preference ID (used for logging/fallback)
            external_reference: External reference to search for payments
        
        Returns:
            dict: {
                "payment_status": str (pending, approved, rejected, etc.),
                "status_detail": str (optional detail)
            }
        """
        # Get Access Token
        token = self._get_access_token()
        
        if not token:
            # Fallback to database
            tx = request.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
            if tx:
                return {"payment_status": tx.status}
            return {"payment_status": "not_found"}
        
        # Use /v1/payments/search to find payments by external_reference
        headers = {
            "Authorization": f"Bearer {token}",
        }
        
        if external_reference:
            search_url = f"https://api.mercadopago.com/v1/payments/search?external_reference={external_reference}"
        else:
            tx = request.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
            if tx and tx.external_reference:
                search_url = f"https://api.mercadopago.com/v1/payments/search?external_reference={tx.external_reference}"
            else:
                search_url = f"https://api.mercadopago.com/v1/payments/search?sort=date_created&criteria=desc"
        
        try:
            response = requests.get(search_url, headers=headers, timeout=20)
            
            try:
                data = response.json()
            except Exception:
                data = {"raw": response.text}
            
            if response.status_code == 200:
                results = data.get("results", [])
                
                if results:
                    # Get the most recent payment matching our criteria
                    payment = results[0]
                    status = payment.get("status", "pending")
                    status_detail = payment.get("status_detail", "")
                    actual_payment_id = payment.get("id")
                    
                    # Update local transaction record if exists
                    tx = request.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
                    if tx and tx.status != status:
                        tx.sudo().write({
                            'status': status,
                            'raw_data': json.dumps(payment),
                        })
                    
                    return {
                        "payment_status": status,
                        "status_detail": status_detail,
                        "payment_id": str(actual_payment_id),
                    }
                else:
                    # No payments found yet - still pending
                    return {"payment_status": "pending"}
            
            elif response.status_code == 401:
                tx = request.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
                if tx:
                    return {"payment_status": tx.status}
                return {"payment_status": "pending"}
            
            elif response.status_code >= 400:
                tx = request.env['mp.transaction'].sudo().search([('mp_payment_id', '=', payment_id)], limit=1)
                if tx:
                    return {"payment_status": tx.status}
                return {"payment_status": "pending"}
                
        except requests.exceptions.Timeout:
            return {"payment_status": "pending"}
        except Exception:
            return {"payment_status": "pending"}
            

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
