from odoo import http
from odoo.http import request

class MPAPI(http.Controller):

    @http.route('/mp/pos/create', type='json', auth='public', csrf=False, cors='*')
    def create_payment(self, **kwargs):
        return {'message': 'MercadoPago create API endpoint active'}

    @http.route('/mp/pos/status', type='json', auth='public', csrf=False, cors='*')
    def status(self, transaction_id=None):
        return {'status': 'pending'}
