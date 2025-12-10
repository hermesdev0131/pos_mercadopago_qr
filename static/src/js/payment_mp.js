/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";
import { MPQRPopup } from "@pos_mercadopago_qr/js/mp_qr_popup";

console.log("MercadoPago POS Module Loaded (Odoo 18) - FIX ADD NEW");

/* 1. Register popup component */
patch(PaymentScreen, {
    components: {
        ...PaymentScreen.components,
        MPQRPopup,
    },
});

/* 2. Patch PaymentScreen Logic */
patch(PaymentScreen.prototype, {
    setup() {
        // 1. Initialize original services/state
        this._super?.(...arguments);

        // 2. Define custom services
        this.mpOrm = useService("orm");
        this.mpNotification = useService("notification");
        
        // 3. Define State
        this.mpqrState = useState({
            visible: false,
            status: "idle",
            qr_url: null,
            payment_id: null,
            amount: 0,
            error: null,
        });
    },

    // --- CRITICAL FIX 1: Hook into ADDING a new payment (Clicking the button) ---
    async addNewPaymentLine(paymentMethod) {
        // Call original to actually add the line
        const result = await this._super(...arguments);
        
        // Check immediately
        if (paymentMethod.name === "MercadoPago") {
            console.log("MercadoPago Added! Triggering Popup...");
            this.showMPQRPopup();
        }
        return result;
    },

    // --- CRITICAL FIX 2: Hook into SELECTING an existing line ---
    selectPaymentLine(paymentLine) {
        this._super(...arguments);
        
        if (paymentLine.payment_method.name === "MercadoPago") {
            console.log("MercadoPago Selected! Triggering Popup...");
            // Only show if not paid
            if (paymentLine.payment_status !== 'done' && paymentLine.payment_status !== 'waitingCard') {
                this.showMPQRPopup();
            }
        } else {
            this.hideMPQRPopup();
        }
    },

    // --- Helpers ---

    get isMercadoPago() {
        // Use standard 'this.pos' (loaded by _super)
        const order = this.pos.get_order();
        if (!order) return false;
        const line = order.selected_paymentline;
        return line && line.payment_method.name === "MercadoPago";
    },

    showMPQRPopup() {
        const order = this.pos.get_order();
        if (this.mpqrState.visible && this.mpqrState.payment_id) return;

        this.mpqrState.visible = true;
        
        // Reset only if fresh start
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
        if (!this.mpqrState.visible) return null;

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

    // --- API Logic ---

    async startMercadoPago() {
        const order = this.pos.get_order();
        const line = order.selected_paymentline;

        if (!line || line.payment_method.name !== "MercadoPago") {
            this.mpNotification.add("Select Mercado Pago first", { type: "warning" });
            return;
        }

        this.mpqrState.status = "loading";

        try {
            const res = await this.mpOrm.call(
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
            const res = await this.mpOrm.call(
                "pos.payment.method",
                "check_mp_status",
                [],
                { payment_id: this.mpqrState.payment_id }
            );

            if (res.payment_status === "approved") {
                this.mpqrState.status = "approved";
                
                const order = this.pos.get_order();
                const line = order.selected_paymentline;
                if (line) line.set_payment_status('done');
                return;
            }

            if (res.payment_status === "pending") {
                setTimeout(() => this._pollStatus(), 3000);
                return;
            }

            this.mpqrState.status = "error";
            this.mpqrState.error = "Payment " + res.payment_status;
        } catch (e) {
            console.error("Polling error", e);
        }
    },
});