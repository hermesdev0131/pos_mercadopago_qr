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
        this.mpState.visible = true;
        
        // Reset state only if not already pending
        if (this.mpState.status !== 'pending') {
            this.mpState.status = "loading";
            this.mpState.error = null;
            this.mpState.qr_url = null;
            
            // Automatically start QR generation
            setTimeout(() => this.startMercadoPago(), 100);
        }
    },
    
    /**
     * Get the current MP payment amount from the selected payment line
     */
    _getMPAmount() {
        const line = this.selectedPaymentLine;
        if (line && line.payment_method_id && line.payment_method_id.name === "MercadoPago") {
            return line.amount || 0;
        }
        // Fallback to order due amount
        const order = this.currentOrder;
        return order ? order.get_due() : 0;
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
            amount: this._getMPAmount(),  // Always get fresh amount from payment line
            qr_url: this.mpState.qr_url,
            error: this.mpState.error,
            onStart: this.startMercadoPago.bind(this),
            onRetry: this._handleMPRetry.bind(this),
            onClose: this._handleMPClose.bind(this),
            onCancel: this._handleMPCancel.bind(this),
            onNewOrder: this._handleMPNewOrder.bind(this),
        };
    },

    // =====================================================
    // POPUP CALLBACKS
    // =====================================================
    
    _handleMPRetry() {
        this.mpState.status = "loading";
        this.mpState.error = null;
        this.mpState.qr_url = null;
        
        // Automatically retry QR generation
        setTimeout(() => this.startMercadoPago(), 100);
    },

    _handleMPClose() {
        // Just close the popup
        this.hideMPQRPopup();
    },

    async _handleMPCancel() {
        // Stop polling
        this.mpState.pollActive = false;
        
        // Get the current MP payment line before cancelling
        const line = this.selectedPaymentLine;
        const lineUuid = line ? line.uuid : null;
        
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
        
        // Reset state and hide popup
        this.mpState.status = "idle";
        this.mpState.payment_id = null;
        this.mpState.qr_url = null;
        this.mpState.error = null;
        this.hideMPQRPopup();
        
        // Delete the MercadoPago payment line
        if (lineUuid) {
            try {
                await super.deletePaymentLine(lineUuid);
                console.log("[MP] Payment line deleted after cancel");
            } catch (e) {
                console.warn("Could not delete payment line:", e);
            }
        }
        
        this.mpNotification.add(
            "Pago cancelado",
            { type: "info" }
        );
    },

    async _handleMPNewOrder() {
        // Hide the popup
        this.hideMPQRPopup();
        
        // Validate the current order (complete the sale)
        try {
            await this.validateOrder(false);
        } catch (e) {
            console.error("Error validating order:", e);
        }
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

        // Get amount from payment line
        const amount = this._getMPAmount();
        
        if (!amount || amount <= 0) {
            this.mpState.status = "error";
            this.mpState.error = "El monto debe ser mayor a 0";
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
                    amount: amount,
                    description: order.name,
                    pos_client_ref: order.name,
                    payment_method_id: line.payment_method_id.id,
                }
            );

            // DEBUG: Log response in browser console
            console.log("=".repeat(60));
            console.log("[MP DEBUG] create_mp_payment response:", res);
            if (res.debug) {
                console.log("[MP DEBUG] Token info:", res.debug);
            }
            console.log("=".repeat(60));

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

            console.log("[MP] Poll status:", res.payment_status);

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

            // Payment still pending OR not found yet - continue polling
            if ((res.payment_status === "pending" || res.payment_status === "not_found") && this.mpState.pollActive) {
                setTimeout(() => this._pollPaymentStatus(), 3000);
                return;
            }

            // Unknown status - but don't error out immediately, keep trying
            console.warn("[MP] Unknown status, will retry:", res.payment_status);
            if (this.mpState.pollActive) {
                setTimeout(() => this._pollPaymentStatus(), 3000);
            }

        } catch (e) {
            console.error("Polling error:", e);
            // On network error, retry after a longer delay
            if (this.mpState.pollActive) {
                setTimeout(() => this._pollPaymentStatus(), 5000);
            }
        }
    },
});
