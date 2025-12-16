from odoo import models, fields

class MPSettings(models.TransientModel):
    _inherit = 'res.config.settings'
    
    mp_access_token = fields.Char(string="MercadoPago Access Token", config_parameter="mp_access_token")
    mp_public_key = fields.Char(string="MercadoPago Public Key", config_parameter="mp_public_key")
    mp_client_id = fields.Char(string="MercadoPago Client ID", config_parameter="mp_client_id")
    mp_client_secret = fields.Char(string="MercadoPago Client Secret", config_parameter="mp_client_secret")
