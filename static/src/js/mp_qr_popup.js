/** @odoo-module **/

import { Component } from "@odoo/owl";

// Simple OWL component, all logic is driven by props
console.log ("QR Popup loaded!");
export class MPQRPopup extends Component {}

MPQRPopup.template = "pos_mercadopago_qr.MPQRPopup";

export default MPQRPopup;
