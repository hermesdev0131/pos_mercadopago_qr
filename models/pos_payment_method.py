from odoo import models, fields

class PosPaymentMethod(models.Model):
    _inherit = 'pos.payment.method'

    use_mercadopago = fields.Boolean(string="Use MercadoPago QR")
