from odoo import models, fields

class MPTransaction(models.Model):
    _name = 'mp.transaction'
    _rec_name = 'mp_payment_id'
    _description = 'MercadoPago POS Transaction'

    pos_order_id = fields.Many2one('pos.order')
    mp_payment_id = fields.Char(index=True)
    status = fields.Char()
    raw_data = fields.Text()
