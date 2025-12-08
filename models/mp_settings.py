from odoo import models, fields

class MPSettings(models.TransientModel):
    _inherit = 'res.config.settings'

    mp_access_token = fields.Char(config_parameter='mp.access.token')
    mp_public_key = fields.Char(config_parameter='mp.public.key')
    mp_client_id = fields.Char(config_parameter='mp.client.id')
    mp_client_secret = fields.Char(config_parameter='mp.client.secret')
