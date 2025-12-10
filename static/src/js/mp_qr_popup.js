/** @odoo-module **/

import { Component } from "@odoo/owl";
import { registry } from "@web/core/registry";

// Simple OWL component, all logic is driven by props
console.log ("QR Popup loaded!");
export class MPQRPopup extends Component {
    static template = "pos_mercadopago_qr.MPQRPopup";
}

registry.category("pos_components").add("MPQRPopup", MPQRPopup);

export default MPQRPopup;
