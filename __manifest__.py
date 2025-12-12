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
        'views/pos_payment_method_view.xml',
    ],
    'assets': {
        "point_of_sale._assets_pos": [
            # CSS Styles
            'pos_mercadopago_qr/static/src/css/mp_qr_popup.css',
            # JS Components
            'pos_mercadopago_qr/static/src/js/mp_qr_popup.js',
            'pos_mercadopago_qr/static/src/js/payment_mp.js',
            # XML Templates
            'pos_mercadopago_qr/static/src/xml/mp_qr_popup.xml',
        ],
    },
    'installable': True,
    'application': False,
}
