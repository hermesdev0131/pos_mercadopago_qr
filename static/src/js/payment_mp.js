/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";
import MPQRPopup from "@pos_mercadopago_qr/js/mp_qr_popup";

console.log("MP Overlay Loaded (Odoo 18)");
console.log("MercadoPago POS Module Loaded (Odoo 18)");

patch(PaymentScreen, {
    components: {
        ...(PaymentScreen.components || {}),
        MPQRPopup,
    },
});

patch(PaymentScreen.prototype, {
    setup() {
        super.setup(...arguments);

        this.orm = useService("orm");
        this.notification = useService("notification");

        this.mpqrState = useState({
            visible: false,
            status: "idle",        // idle | loading | pending | approved | error
            qr_url: null,
            payment_id: null,
            amount: 0,
            error: null,
        });
    },

    // Helper to get selected payment line
    _mpqrGetSelectedPaymentLine() {
        const order = this.currentOrder;
        if (!order) {
            return null;
        }
        const lines = order.paymentLines || [];
        return lines.find((l) => l.selected);
    },

    get isMercadoPagoSelected() {
        const line = this._mpqrGetSelectedPaymentLine();
        return !!(line && line.payment_method && line.payment_method.name === "MercadoPago");
    },

    // Popup control
    showMPQRPopup() {
        if (!this.isMercadoPagoSelected) {
            this.notification.add(
                this.env._t("Please select the Mercado Pago payment method first."),
                { type: "warning" }
            );
            return;
        }

        const order = this.currentOrder;
        let amount = 0;
        if (order) {
            if (order.get_due) {
                amount = order.get_due();
            } else if (order.get_total_with_tax) {
                amount = order.get_total_with_tax();
            }
        }

        this.mpqrState.visible = true;
        this.mpqrState.status = "idle";
        this.mpqrState.error = null;
        this.mpqrState.amount = amount;
    },

    hideMPQRPopup() {
        this.mpqrState.visible = false;
    },

    get mpqrPopupProps() {
        if (!this.mpqrState.visible) {
            return null;
        }

        return {
            status: this.mpqrState.status,
            qr_url: this.mpqrState.qr_url,
            amount: this.mpqrState.amount,
            error: this.mpqrState.error,
            onStart: this.startMercadoPago.bind(this),
            onRetry: () => {
                this.mpqrState.status = "idle";
                this.mpqrState.error = null;
            },
            onClose: () => {
                this.hideMPQRPopup();
            },
        };
    },

    // Patch: when user clicks a payment method
    async clickPaymentMethod(paymentMethod) {
        const res = await super.clickPaymentMethod(...arguments);

        if (paymentMethod && paymentMethod.name === "MercadoPago") {
            this.showMPQRPopup();
        }

        return res;
    },

    // Start Mercado Pago payment
    async startMercadoPago() {
        if (!this.isMercadoPagoSelected) {
            this.notification.add(
                this.env._t("Select the Mercado Pago payment method to generate the QR."),
                { type: "warning" }
            );
            return;
        }

        if (this.mpqrState.status === "loading" || this.mpqrState.status === "pending") {
            return;
        }

        const order = this.currentOrder;
        if (!order) {
            this.mpqrState.status = "error";
            this.mpqrState.error = "No active order.";
            return;
        }

        const line = this._mpqrGetSelectedPaymentLine();
        if (!line) {
            this.mpqrState.status = "error";
            this.mpqrState.error = "No payment line selected.";
            return;
        }

        const amount = this.mpqrState.amount;

        try {
            this.mpqrState.status = "loading";
            this.mpqrState.error = null;

            const result = await this.orm.call(
                "pos.payment.method",
                "create_mp_payment",
                [],
                {
                    amount: amount,
                    description: order.name,
                    pos_client_ref: order.name,
                    payment_method_id: line.payment_method.id,
                }
            );

            if (!result || result.status !== "success") {
                const msg = (result && result.details) || "Error creating Mercado Pago payment.";
                this.mpqrState.status = "error";
                this.mpqrState.error = msg;
                this.notification.add(msg, { type: "danger" });
                return;
            }

            this.mpqrState.status = "pending";
            this.mpqrState.qr_url = result.qr_data;
            this.mpqrState.payment_id = result.payment_id;

            this._mpqrPollStatus();
        } catch (err) {
            console.error("MercadoPago error:", err);
            this.mpqrState.status = "error";
            this.mpqrState.error = "Unexpected error while connecting to Mercado Pago.";
            this.notification.add(this.mpqrState.error, { type: "danger" });
        }
    },

    async _mpqrPollStatus() {
        if (!this.mpqrState.payment_id) {
            return;
        }

        try {
            const result = await this.orm.call(
                "pos.payment.method",
                "check_mp_status",
                [],
                {
                    payment_id: this.mpqrState.payment_id,
                }
            );

            if (!result || !result.payment_status) {
                this.mpqrState.status = "error";
                this.mpqrState.error = "Unknown status from Mercado Pago.";
                return;
            }

            if (result.payment_status === "approved") {
                this.mpqrState.status = "approved";
                this.notification.add(
                    this.env._t("Mercado Pago payment approved."),
                    { type: "success" }
                );

                const order = this.currentOrder;
                const line = this._mpqrGetSelectedPaymentLine();
                if (order && line && line.set_payment_status) {
                    line.set_payment_status("done");
                }
                return;
            }

            if (result.payment_status === "pending") {
                setTimeout(() => this._mpqrPollStatus(), 3000);
            } else {
                this.mpqrState.status = "error";
                this.mpqrState.error = "Payment " + result.payment_status;
            }
        } catch (e) {
            console.error("MercadoPago polling error", e);
            this.mpqrState.status = "error";
            this.mpqrState.error = "Error when checking Mercado Pago status.";
        }
    },

    // Protect validateOrder while payment is pending
    async validateOrder(isForceValidate) {
        if (this.isMercadoPagoSelected && this.mpqrState.status === "pending") {
            this.notification.add(
                this.env._t("Wait for Mercado Pago payment confirmation before validating the order."),
                { type: "warning" }
            );
            return;
        }
        return super.validateOrder(...arguments);
    },
});
