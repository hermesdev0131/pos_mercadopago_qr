/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";
import { useService } from "@web/core/utils/hooks";
import { useState } from "@odoo/owl";
import { MPQRPopup } from "@pos_mercadopago_qr/js/mp_qr_popup";

console.log("MercadoPago POS Module Loaded (Odoo 18)");

// 1. Register Popup Component
patch(PaymentScreen, {
    components: {
        ...PaymentScreen.components,
        MPQRPopup,
    },
});

// 2. Patch PaymentScreen Logic
patch(PaymentScreen.prototype, {
    setup() {
        super.setup();

        this.mpOrm = useService("orm");
        this.mpNotification = useService("notification");

        // MercadoPago popup state
        this.mpState = useState({
            visible: false,
            status: "idle",      // idle | loading | pending | approved | error
            qr_url: null,
            payment_id: null,
            amount: 0,
            error: null,
            pollActive: false,   // Flag to control polling
        });
    },

    // =====================================================
    // OVERRIDE: Block order validation while MP is active
    // =====================================================
    
    /**
     * Override to block validation while MercadoPago payment is pending
     */
    async validateOrder(isForceValidate) {
        if (this._isMPPaymentPending()) {
            this.mpNotification.add(
                "No se puede validar la orden mientras hay un pago de MercadoPago pendiente.",
                { type: "warning", title: "Pago Pendiente" }
            );
            return false;
        }
        return super.validateOrder(isForceValidate);
    },

    /**
     * Check if there's a pending MercadoPago payment
     */
    _isMPPaymentPending() {
        return this.mpState.visible && 
               (this.mpState.status === "pending" || this.mpState.status === "loading");
    },

    // =====================================================
    // OVERRIDE: Handle payment line selection
    // =====================================================
    
    selectPaymentLine(uuid) {
        super.selectPaymentLine(uuid);

        const line = this.paymentLines.find((l) => l.uuid === uuid);

        if (line && line.payment_method_id && line.payment_method_id.name === "MercadoPago") {
            console.log("MP Line Selected (UUID match)");
            
            const status = line.get_payment_status();
            if (status !== 'done' && status !== 'waitingCard') {
                this.showMPQRPopup();
            }
        } else {
            this.hideMPQRPopup();
        }
    },

    // =====================================================
    // OVERRIDE: Handle new payment line
    // =====================================================
    
    async addNewPaymentLine(paymentMethod) {
        const result = await super.addNewPaymentLine(paymentMethod);

        if (paymentMethod.name === "MercadoPago") {
            console.log("New MP Payment Line Added");
            this.showMPQRPopup();
        }
        return result;
    },

    // =====================================================
    // OVERRIDE: Block payment method changes while pending
    // =====================================================
    
    async deletePaymentLine(uuid) {
        const line = this.paymentLines.find((l) => l.uuid === uuid);
        
        if (line && line.payment_method_id && line.payment_method_id.name === "MercadoPago") {
            if (this._isMPPaymentPending()) {
                this.mpNotification.add(
                    "Cancele el pago de MercadoPago antes de eliminar la línea.",
                    { type: "warning", title: "Pago Pendiente" }
                );
                return;
            }
        }
        
        return super.deletePaymentLine(uuid);
    },

    // =====================================================
    // POPUP MANAGEMENT
    // =====================================================
    
    showMPQRPopup() {
        const order = this.currentOrder;
        this.mpState.visible = true;
        
        // Reset state only if not already pending
        if (this.mpState.status !== 'pending') {
            this.mpState.status = "idle";
            this.mpState.error = null;
            this.mpState.qr_url = null;
            this.mpState.amount = order ? order.get_due() : 0;
        }
    },

    hideMPQRPopup() {
        // Stop polling when hiding
        this.mpState.pollActive = false;
        this.mpState.visible = false;
    },

    /**
     * Props getter for the MPQRPopup component
     */
    get mpqrPopupProps() {
        if (!this.mpState.visible) return null;
        
        return {
            status: this.mpState.status,
            amount: this.mpState.amount,
            qr_url: this.mpState.qr_url,
            error: this.mpState.error,
            onStart: this.startMercadoPago.bind(this),
            onRetry: this._handleMPRetry.bind(this),
            onClose: this._handleMPClose.bind(this),
            onCancel: this._handleMPCancel.bind(this),
        };
    },

    // =====================================================
    // POPUP CALLBACKS
    // =====================================================
    
    _handleMPRetry() {
        this.mpState.status = "idle";
        this.mpState.error = null;
        this.mpState.qr_url = null;
    },

    _handleMPClose() {
        // If payment was approved, we can close safely
        if (this.mpState.status === "approved") {
            this.hideMPQRPopup();
            return;
        }
        
        // For other states, just hide
        this.hideMPQRPopup();
    },

    async _handleMPCancel() {
        // Stop polling
        this.mpState.pollActive = false;
        
        // If there's an active payment, try to cancel it on the backend
        if (this.mpState.payment_id) {
            try {
                await this.mpOrm.call(
                    "pos.payment.method",
                    "cancel_mp_payment",
                    [],
                    { payment_id: this.mpState.payment_id }
                );
            } catch (e) {
                console.warn("Could not cancel MP payment:", e);
            }
        }
        
        // Reset state
        this.mpState.status = "idle";
        this.mpState.payment_id = null;
        this.mpState.qr_url = null;
        this.mpState.error = null;
        
        this.mpNotification.add(
            "Pago cancelado",
            { type: "info" }
        );
    },

    // =====================================================
    // MERCADOPAGO API CALLS
    // =====================================================
    
    /**
     * Start the MercadoPago payment flow
     */
    async startMercadoPago() {
        const order = this.currentOrder;
        const line = this.selectedPaymentLine;

        if (!line) {
            this.mpState.status = "error";
            this.mpState.error = "No hay línea de pago seleccionada";
            return;
        }

        this.mpState.status = "loading";
        this.mpState.error = null;

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
                this.mpState.error = res.details || "Error al crear el pago";
                return;
            }

            // Success - show QR and start polling
            this.mpState.status = "pending";
            this.mpState.qr_url = res.qr_data;
            this.mpState.payment_id = res.payment_id;
            this.mpState.pollActive = true;
            
            this._pollPaymentStatus();

        } catch (err) {
            console.error("MercadoPago Error:", err);
            this.mpState.status = "error";
            this.mpState.error = "Error de conexión con MercadoPago";
        }
    },

    /**
     * Poll for payment status updates
     */
    async _pollPaymentStatus() {
        // Check if we should continue polling
        if (!this.mpState.payment_id || !this.mpState.visible || !this.mpState.pollActive) {
            return;
        }

        try {
            const res = await this.mpOrm.call(
                "pos.payment.method",
                "check_mp_status",
                [],
                { payment_id: this.mpState.payment_id }
            );

            // Payment approved
            if (res.payment_status === "approved") {
                this.mpState.status = "approved";
                this.mpState.pollActive = false;
                
                // Mark payment line as done
                const line = this.selectedPaymentLine;
                if (line) {
                    line.set_payment_status('done');
                }
                
                this.mpNotification.add(
                    "¡Pago aprobado exitosamente!",
                    { type: "success", title: "MercadoPago" }
                );
                return;
            }

            // Payment rejected or cancelled
            if (res.payment_status === "rejected" || res.payment_status === "cancelled") {
                this.mpState.status = "error";
                this.mpState.error = `Pago ${res.payment_status === "rejected" ? "rechazado" : "cancelado"}`;
                this.mpState.pollActive = false;
                return;
            }

            // Payment still pending - continue polling
            if (res.payment_status === "pending" && this.mpState.pollActive) {
                setTimeout(() => this._pollPaymentStatus(), 3000);
                return;
            }

            // Unknown status
            this.mpState.status = "error";
            this.mpState.error = `Estado desconocido: ${res.payment_status}`;
            this.mpState.pollActive = false;

        } catch (e) {
            console.error("Polling error:", e);
            // On network error, retry after a longer delay
            if (this.mpState.pollActive) {
                setTimeout(() => this._pollPaymentStatus(), 5000);
            }
        }
    },
});
