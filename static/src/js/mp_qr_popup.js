/** @odoo-module */

import { Component } from "@odoo/owl";
import { Dialog } from "@web/core/dialog/dialog";
import { _t } from "@web/core/l10n/translation";

console.log("MPQR Loaded!");
export class MPQRPopup extends Component {
    static template = "pos_mercadopago_qr.MPQRPopup";
    static components = { Dialog };
    static props = {
        title: { type: String, optional: true },
        qr_url: { type: String, optional: true },
        amount: { type: Number, optional: true },
        status: { type: String }, 
        error: { type: String, optional: true },
        onStart: { type: Function, optional: true },
        onRetry: { type: Function, optional: true },
        onClose: { type: Function },
        close: { type: Function, optional: true }, // Inherited from Dialog
    };
    static defaultProps = {
        title: _t("Mercado Pago QR"),
        status: "idle",
    };
}