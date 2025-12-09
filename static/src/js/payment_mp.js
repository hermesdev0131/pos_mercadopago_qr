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
            visible: true,
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
        const isSelected = line && line.payment_method?.name === "MercadoPago";
        console.log("isMPSelected check:", { isSelected, line: line?.payment_method?.name });
        return isSelected;
    },

    // --- Overlay control ---
    showMPOverlay() {
        console.log("showMPOverlay called, isMPSelected:", this.isMPSelected);
        if (!this.isMPSelected) {
            console.log("MP not selected, returning");
            return;
        }
        this.mpState.visible = true;
        this.mpState.status = "idle";
        this.mpState.amount = this.currentOrder.get_due();
        console.log("MP overlay shown:", { visible: this.mpState.visible, status: this.mpState.status, amount: this.mpState.amount });
    },

    hideMPOverlay() {
        console.log("hideMPOverlay called");
        this.mpState.visible = false;
    },

    get mpOverlayProps() {
        console.log("mpOverlayProps getter called, visible:", this.mpState.visible);
        if (!this.mpState.visible) {
            console.log("mpState.visible is false, returning null");
            return null;
        }
        const props = {
            status: this.mpState.status,
            qr_url: this.mpState.qr_url,
            amount: this.mpState.amount,
            error: this.mpState.error,
            onStart: this.startMP.bind(this),
            onRetry: () => { this.mpState.status = "idle"; },
            onClose: () => { this.hideMPOverlay(); },
        };
        console.log("mpOverlayProps returning:", props);
        return props;
    },

    // --- Start MercadoPago ---
    async startMP() {
        console.log("startMP called");
        const line = this._getSelectedPaymentLine();
        if (!line) {
            console.log("No payment line found");
            return;
        }

        this.mpState.status = "loading";
        console.log("Status set to loading");

        try {
            console.log("Calling create_mp_payment with:", { 
                amount: this.mpState.amount, 
                description: this.currentOrder.name 
            });
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

            console.log("create_mp_payment result:", result);
            if (result.status !== "success") {
                this.mpState.status = "error";
                this.mpState.error = result.details;
                console.log("Payment creation failed:", result.details);
                return;
            }

            this.mpState.qr_url = result.qr_data;
            this.mpState.payment_id = result.payment_id;
            this.mpState.status = "pending";
            console.log("Payment pending, qr_url and payment_id set", { qr_url: this.mpState.qr_url, payment_id: this.mpState.payment_id });

            this._pollMPStatus();

        } catch (err) {
            console.error("Error in startMP:", err);
            this.mpState.status = "error";
            this.mpState.error = "Unexpected error.";
        }
    },

    // --- Polling ---
    async _pollMPStatus() {
        console.log("_pollMPStatus called, payment_id:", this.mpState.payment_id);
        if (!this.mpState.payment_id) {
            console.log("No payment_id, returning");
            return;
        }

        try {
            console.log("Polling status for payment_id:", this.mpState.payment_id);
            const result = await this.orm.call(
                "pos.payment.method",
                "check_mp_status",
                [],
                { payment_id: this.mpState.payment_id }
            );

            console.log("Poll result:", result);
            if (result.payment_status === "approved") {
                this.mpState.status = "approved";
                const line = this._getSelectedPaymentLine();
                line?.set_payment_status("done");
                console.log("Payment approved!");
                return;
            }

            if (result.payment_status === "pending") {
                console.log("Payment still pending, will poll again in 3s");
                setTimeout(() => this._pollMPStatus(), 3000);
            } else {
                this.mpState.status = "error";
                this.mpState.error = "Payment " + result.payment_status;
                console.log("Payment failed with status:", result.payment_status);
            }
        } catch (e) {
            console.error("Polling error:", e);
            this.mpState.status = "error";
            this.mpState.error = "Polling failed.";
        }
    },

});
