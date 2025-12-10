/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useState, onWillUpdateProps } from "@odoo/owl";
import { useService } from "@web/core/utils/hooks";
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
            lastSelectedMethod: null,
        });

        onWillUpdateProps(() => {
            this._checkMercadoPagoSelected();
        });

        console.log("--Setup Success!---");
        console.log("Available methods on PaymentScreen:", Object.getOwnPropertyNames(PaymentScreen.prototype));
    },

    async selectPaymentLine(paymentLine) {
        // 1. Call the original Odoo logic (highlights the button, sets state)
        await super.selectPaymentLine(...arguments);
        
        // 2. Run our check immediately after selection
        this._checkMercadoPagoSelected();
    },

    _checkMercadoPagoSelected() {
        const line = this._mpqrLine();
        
        if (!line) {
            this.hideMPQRPopup();
            return;
        }

        const methodName = line.payment_method.name;

        // If Mercado Pago is selected
        if (methodName === "MercadoPago") {
            // Only show if not already paid/finished
            if (line.payment_status !== 'done' && line.payment_status !== 'waitingCard') {
                console.log("MercadoPago selected! Opening popup...");
                this.showMPQRPopup();
            }
        } else {
            // User switched to Cash/Bank/etc
            this.hideMPQRPopup();
        }
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
        // Don't reset if we are already showing the same payment
        if (this.mpqrState.visible && this.mpqrState.payment_id) return;

        this.mpqrState.visible = true;
        
        // Only reset status if we don't have an active payment for this line
        // (You could improve this by storing payment_id on the line itself)
        if (this.mpqrState.status !== 'pending') {
            this.mpqrState.status = "idle";
            this.mpqrState.error = null;
            this.mpqrState.amount = order?.get_due() ?? 0;
        }
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
        if (!this.mpqrState.payment_id || !this.mpqrState.visible) return;

        try {
            const res = await this.orm.call(
                "pos.payment.method",
                "check_mp_status",
                [],
                { payment_id: this.mpqrState.payment_id }
            );

            if (res.payment_status === "approved") {
                this.mpqrState.status = "approved";
                
                // Mark line as paid in Odoo
                const line = this._mpqrLine();
                if (line) {
                    line.set_payment_status('done');
                }
                return;
            }

            if (res.payment_status === "pending") {
                setTimeout(() => this._pollStatus(), 3000);
                return;
            }

            this.mpqrState.status = "error";
            this.mpqrState.error = "Payment " + res.payment_status;
        } catch (e) {
            // network error or close? stop polling or retry silently
            console.error("Polling error", e);
        }
    },
});
