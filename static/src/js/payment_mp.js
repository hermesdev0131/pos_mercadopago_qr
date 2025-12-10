/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";
import { MPQRPopup } from "@pos_mercadopago_qr/js/mp_qr_popup";

console.log("MercadoPago POS Module Loaded (Odoo 18 - UUID Fix)");

// 1. Register Popup
patch(PaymentScreen, {
    components: {
        ...PaymentScreen.components,
        MPQRPopup,
    },
});

// 2. Patch Logic
patch(PaymentScreen.prototype, {
    setup() {
        // Run original setup to initialize 'this.pos', 'this.ui', 'this.payment_methods_from_config'
        super.setup();

        this.mpOrm = useService("orm");
        this.mpNotification = useService("notification");

        this.mpState = useState({
            visible: false,
            status: "idle",
            qr_url: null,
            payment_id: null,
            amount: 0,
            error: null,
        });
    },

    // --- OVERRIDE: Select Existing Line (Fixing the UUID issue) ---
    selectPaymentLine(uuid) {
        // 1. Call original method (uses UUID)
        super.selectPaymentLine(uuid);

        // 2. Resolve the line object using the UUID provided
        const line = this.paymentLines.find((line) => line.uuid === uuid);

        if (line && line.payment_method_id && line.payment_method_id.name === "MercadoPago") {
            console.log("MP Line Selected (UUID match)");
            
            // 3. Check status
            const status = line.get_payment_status();
            if (status !== 'done' && status !== 'waitingCard') {
                this.showMPQRPopup();
            }
        } else {
            this.hideMPQRPopup();
        }
    },

    // --- OVERRIDE: Add New Payment Line ---
    async addNewPaymentLine(paymentMethod) {
        // 1. Call original
        const result = await super.addNewPaymentLine(paymentMethod);

        // 2. Check the method object directly
        if (paymentMethod.name === "MercadoPago") {
            console.log("New MP Line Added");
            this.showMPQRPopup();
        }
        return result;
    },

    // --- POPUP LOGIC ---
    showMPQRPopup() {
        const order = this.currentOrder; // Use the component's getter
        this.mpState.visible = true;
        
        // Reset only if not already pending
        if (this.mpState.status !== 'pending') {
            this.mpState.status = "idle";
            this.mpState.error = null;
            this.mpState.amount = order ? order.get_due() : 0;
        }
    },

    hideMPQRPopup() {
        this.mpState.visible = false;
    },

    get mpqrPopupProps() {
        if (!this.mpState.visible) return null;
        return {
            status: this.mpState.status,
            amount: this.mpState.amount,
            qr_url: this.mpState.qr_url,
            error: this.mpState.error,
            onStart: this.startMercadoPago.bind(this),
            onRetry: () => { this.mpState.status = "idle"; this.mpState.error = null; },
            onClose: () => this.hideMPQRPopup(),
        };
    },

    // --- API CALLS ---
    async startMercadoPago() {
        const order = this.currentOrder;
        // Use the helper from your source code
        const line = this.selectedPaymentLine; 

        if (!line) return;

        this.mpState.status = "loading";

        try {
            const res = await this.mpOrm.call(
                "pos.payment.method", 
                "create_mp_payment", 
                [], 
                {
                    amount: this.mpState.amount,
                    description: order.name,
                    pos_client_ref: order.name,
                    payment_method_id: line.payment_method_id.id,
                }
            );

            if (res.status !== "success") {
                this.mpState.status = "error";
                this.mpState.error = res.details;
                return;
            }

            this.mpState.status = "pending";
            this.mpState.qr_url = res.qr_data;
            this.mpState.payment_id = res.payment_id;
            this._pollStatus();

        } catch (err) {
            console.error(err);
            this.mpState.status = "error";
            this.mpState.error = "Connection Error";
        }
    },

    async _pollStatus() {
        if (!this.mpState.payment_id || !this.mpState.visible) return;

        try {
            const res = await this.mpOrm.call(
                "pos.payment.method", "check_mp_status", [], 
                { payment_id: this.mpState.payment_id }
            );

            if (res.payment_status === "approved") {
                this.mpState.status = "approved";
                
                const line = this.selectedPaymentLine;
                if (line) line.set_payment_status('done');
                return;
            }

            if (res.payment_status === "pending") {
                setTimeout(() => this._pollStatus(), 3000);
                return;
            }

            this.mpState.status = "error";
            this.mpState.error = "Payment " + res.payment_status;
        } catch (e) { console.error(e); }
    },
});