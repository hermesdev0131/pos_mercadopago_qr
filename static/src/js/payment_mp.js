/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";
import MPOverlay from "@pos_mercadopago_qr/js/mp_overlay";

console.log("MercadoPago POS Module Loaded (Odoo 18)");

patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);

        this.orm = useService("orm");
        this.notification = useService("notification");

        this.mpState = useState({
            visible: false,
            status: "idle",
            qr_url: null,
            payment_id: null,
            amount: 0,
            error: null,
        });
    },

    // --- Helpers ---
    _getSelectedPaymentLine() {
        const order = this.currentOrder;
        if (!order) return null;
        const lines = order.paymentLines || [];
        return lines.find(l => l.selected);
    },

    get isMPSelected() {
        const line = this._getSelectedPaymentLine();
        return line && line.payment_method?.name === "MercadoPago";
    },

    // --- Overlay control ---
    showMPOverlay() {
        if (!this.isMPSelected) return;
        this.mpState.visible = true;
        this.mpState.status = "idle";
        this.mpState.amount = this.currentOrder.get_due();
    },

    hideMPOverlay() {
        this.mpState.visible = false;
    },

    get mpOverlayProps() {
        if (!this.mpState.visible) return null;
        return {
            status: this.mpState.status,
            qr_url: this.mpState.qr_url,
            amount: this.mpState.amount,
            error: this.mpState.error,
            onStart: this.startMP.bind(this),
            onRetry: () => { this.mpState.status = "idle"; },
            onClose: () => { this.hideMPOverlay(); },
        };
    },

    // --- Start MercadoPago ---
    async startMP() {
        const line = this._getSelectedPaymentLine();
        if (!line) return;

        this.mpState.status = "loading";

        try {
            const result = await this.orm.call(
                "pos.payment.method",
                "create_mp_payment",
                [],
                {
                    amount: this.mpState.amount,
                    description: this.currentOrder.name,
                    payment_method_id: line.payment_method.id,
                }
            );

            if (result.status !== "success") {
                this.mpState.status = "error";
                this.mpState.error = result.details;
                return;
            }

            this.mpState.qr_url = result.qr_data;
            this.mpState.payment_id = result.payment_id;
            this.mpState.status = "pending";

            this._pollMPStatus();

        } catch (err) {
            this.mpState.status = "error";
            this.mpState.error = "Unexpected error.";
        }
    },

    // --- Polling ---
    async _pollMPStatus() {
        if (!this.mpState.payment_id) return;

        try {
            const result = await this.orm.call(
                "pos.payment.method",
                "check_mp_status",
                [],
                { payment_id: this.mpState.payment_id }
            );

            if (result.payment_status === "approved") {
                this.mpState.status = "approved";
                const line = this._getSelectedPaymentLine();
                line?.set_payment_status("done");
                return;
            }

            if (result.payment_status === "pending") {
                setTimeout(() => this._pollMPStatus(), 3000);
            } else {
                this.mpState.status = "error";
                this.mpState.error = "Payment " + result.payment_status;
            }
        } catch (e) {
            this.mpState.status = "error";
            this.mpState.error = "Polling failed.";
        }
    },

});
