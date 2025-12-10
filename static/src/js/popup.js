/** @odoo-module */
import { Dialog } from "@web/core/dialog/dialog";
import { usePos } from "@point_of_sale/app/store/pos_hook";
import { Component, useState } from "@odoo/owl";
export class InfoPopup extends Component {
    static template = "pos_custom_popup.InfoPopup";
    static components = { Dialog };
    setup() {
        this.pos = usePos();
        const partner = this.props.order.get_partner?.() || {}; 
        this.state = useState({
            customer: partner.name ?? "", 
            notes: this.props.order.general_note || "",
        });
    }
    async confirm() {
        this.props.getPayload(this.state);
        this.props.close();
    }
}