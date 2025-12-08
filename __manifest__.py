{
    'name': "MercadoPago QR for POS",
    'version': '1.0.0',
    'summary': "Adds MercadoPago QR as a payment method for Odoo 18 POS",
    'category': "Point of Sale",
    "license": "LGPL-3",
    'author': "Hiroshi",
    'depends': ['point_of_sale', 'account'],
    'data': [
        'security/ir.model.access.csv',
        'views/mp_settings_view.xml',
    ],
    'assets': {
        'point_of_sale.assets': [
            'pos_mercadopago_qr/static/src/pos/js/*.js',
            'pos_mercadopago_qr/static/src/pos/xml/*.xml',
        ],
    },
    'installable': True,
    'application': False,
}
