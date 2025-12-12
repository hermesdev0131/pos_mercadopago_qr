from odoo import models, fields

class MPTransaction(models.Model):
    _name = 'mp.transaction'
    _rec_name = 'mp_payment_id'
    _description = 'MercadoPago POS Transaction'
    _order = 'create_date desc'

    pos_order_id = fields.Many2one('pos.order', string="POS Order")
    mp_payment_id = fields.Char(index=True, string="MP Payment ID")
    external_reference = fields.Char(index=True, string="External Reference")
    qr_data = fields.Text(string="QR Data / URL")
    status = fields.Selection([
        ('pending', 'Pending'),
        ('approved', 'Approved'),
        ('rejected', 'Rejected'),
        ('cancelled', 'Cancelled'),
    ], string="Status", default='pending')
    amount = fields.Float(string="Amount", digits=(12, 2))
    raw_data = fields.Text(string="Raw Response JSON")
