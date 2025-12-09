/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useState, useService } from "@odoo/owl";
import { MPQRPopup } from "@pos_mercadopago_qr/js/mp_qr_popup";

console.log("MercadoPago POS Module Loaded (Odoo 18)");

/* Register popup component with screen */
patch(PaymentScreen, {
    components: {
        ...PaymentScreen.components,
        MPQRPopup,
    },
});

patch(PaymentScreen.prototype, {
    setup() {
        super.setup();

        this.orm = useService("orm");
        this.notification = useService("notification");

        this.mpqrState = useState({
            visible: false,
            status: "idle",
            qr_url: null,
            payment_id: null,
            amount: 0,
            error: null,
        });
    },

    // helper
    _mpqrLine() {
        const order = this.currentOrder;
        return order?.paymentLines?.find(l => l.selected) || null;
    },

    get isMercadoPagoSelected() {
        const line = this._mpqrLine();
        return line?.payment_method?.name === "MercadoPago";
    },

    showMPQRPopup() {
        const order = this.currentOrder;

        this.mpqrState.visible = true;
        this.mpqrState.status = "idle";
        this.mpqrState.error = null;
        this.mpqrState.amount = order?.get_due() ?? 0;
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
            amount: this.mpqrState.amount,
            qr_url: this.mpqrState.qr_url,
            error: this.mpqrState.error,
            onStart: this.startMercadoPago.bind(this),
            onRetry: () => {
                this.mpqrState.status = "idle";
                this.mpqrState.error = null;
            },
            onClose: () => this.hideMPQRPopup(),
        };
    },

    async clickPaymentMethod(paymentMethod) {
        await super.clickPaymentMethod(...arguments);

        if (paymentMethod?.name === "MercadoPago") {
            this.showMPQRPopup();
        }
    },

    /* BACKEND CALL */
    async startMercadoPago() {
        if (!this.isMercadoPagoSelected) {
            this.notification.add("Select Mercado Pago payment method first", {
                type: "warning",
            });
            return;
        }

        const order = this.currentOrder;
        const line = this._mpqrLine();

        this.mpqrState.status = "loading";

        try {
            const res = await this.orm.call(
                "pos.payment.method",
                "create_mp_payment",
                [],
                {
                    amount: this.mpqrState.amount,
                    description: order.name,
                    pos_client_ref: order.name,
                    payment_method_id: line.payment_method.id,
                }
            );

            if (res.status !== "success") {
                this.mpqrState.status = "error";
                this.mpqrState.error = res.details;
                return;
            }

            this.mpqrState.status = "pending";
            this.mpqrState.qr_url = res.qr_data;
            this.mpqrState.payment_id = res.payment_id;

            this._pollStatus();
        } catch (err) {
            console.error(err);
            this.mpqrState.status = "error";
            this.mpqrState.error = "Unexpected error.";
        }
    },

    async _pollStatus() {
        if (!this.mpqrState.payment_id) return;

        try {
            const res = await this.orm.call(
                "pos.payment.method",
                "check_mp_status",
                [],
                { payment_id: this.mpqrState.payment_id }
            );

            if (res.payment_status === "approved") {
                this.mpqrState.status = "approved";
                const line = this._mpqrLine();
                line?.set_payment_status?.("done");
                return;
            }

            if (res.payment_status === "pending") {
                setTimeout(() => this._pollStatus(), 3000);
                return;
            }

            this.mpqrState.status = "error";
            this.mpqrState.error = "Payment " + res.payment_status;
        } catch {
            this.mpqrState.status = "error";
            this.mpqrState.error = "Polling error";
        }
    },
});
