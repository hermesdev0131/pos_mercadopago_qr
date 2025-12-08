from odoo import http
from odoo.http import request

class MPWebhook(http.Controller):

    @http.route('/mp/pos/webhook', type='json', auth='public', csrf=False, cors='*')
    def webhook(self, **payload):
        # Placeholder handler
        return {'status': 'received'}
