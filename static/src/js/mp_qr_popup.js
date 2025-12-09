/** @odoo-module **/

import { useService } from "@web/core/utils/hooks";
import { Component, useState } from "@odoo/owl";
import { PosPopup } from "@point_of_sale/app/components/popups/popups";

console.log("QR PopUp Loaded!");
export class MPQRPopup extends PosPopup {
    setup() {
        super.setup();
        this.state = useState({
            status: this.props.status,
            qr_url: this.props.qr_url,
            error: this.props.error,
        });
    }

    close() {
        this.props.close();
    }
}

MPQRPopup.template = "pos_mercadopago_qr.MPQRPopup";
