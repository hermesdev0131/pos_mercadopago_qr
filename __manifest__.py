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
        'point_of_sale.assets_prod': [
            'pos_mercadopago_qr/static/src/js/PaymentMP.js',
            'pos_mercadopago_qr/static/src/xml/PaymentMP.xml',
        ],
        'point_of_sale.assets_debug': [
            'pos_mercadopago_qr/static/src/js/PaymentMP.js',
            'pos_mercadopago_qr/static/src/xml/PaymentMP.xml',
        ],
    },
    'installable': True,
    'application': False,
}
