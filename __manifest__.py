{
    'name': "Mercado Pago QR for Odoo POS",
    'version': '18.0.1.0.0',
    'summary': "Accept Mercado Pago QR payments in Odoo POS with real-time confirmation.",
    'category': "Point of Sale",
     "description": """
Accept Mercado Pago QR payments directly in Odoo Point of Sale.

This module allows businesses to generate Mercado Pago QR codes from Odoo POS,
enabling fast, secure, and cardless payments with real-time confirmation.
Optimized for LATAM markets.
    """,
    "license": "LGPL-3",
    'author': "Hiroshi, WolfAIX",
    'website': "https://www.wolfaix.com",
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
     "auto_install": False,
}
