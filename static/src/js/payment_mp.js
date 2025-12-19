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
            external_reference: null,  // Store external reference for accurate payment status checking
            error: null,
            pollActive: false,   // Flag to control polling
            currentOrderUid: null,  // Track current order to detect changes
            currentPaymentLineUuid: null,  // Track current payment line to detect changes
        });

        // Timer for auto-navigation after payment approval
        this.autoNavigateTimer = null;
    },

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

    _isMPPaymentPending() {
        return this.mpState.visible && 
               (this.mpState.status === "pending" || this.mpState.status === "loading");
    },

    _isMercadoPagoPayment(paymentMethod) {
        // Check if payment method uses MercadoPago QR via boolean field
        // This is robust against name changes, translations, and variations
        if (!paymentMethod) {
            return false;
        }
        return paymentMethod.use_mercadopago_qr === true;
    },

    
    selectPaymentLine(uuid) {
        super.selectPaymentLine(uuid);

        const line = this.paymentLines.find((l) => l.uuid === uuid);
        const order = this.currentOrder;

        if (line && line.payment_method_id && this._isMercadoPagoPayment(line.payment_method_id)) {
            // Check if order or payment line changed
            const orderUid = order ? order.uid : null;
            const lineUuid = line.uuid;
            
            if (this.mpState.currentOrderUid !== orderUid || 
                this.mpState.currentPaymentLineUuid !== lineUuid) {
                // Different order or payment line - reset state
                this._resetMPState();
                this.mpState.currentOrderUid = orderUid;
                this.mpState.currentPaymentLineUuid = lineUuid;
            }
            
            const status = line.get_payment_status();
            if (status !== 'done' && status !== 'waitingCard') {
                this.showMPQRPopup();
            }
        } else {
            // Not MercadoPago payment - hide popup and reset if needed
            if (this.mpState.currentPaymentLineUuid !== uuid) {
                this._resetMPState();
            }
            this.hideMPQRPopup();
        }
    },

    
    async addNewPaymentLine(paymentMethod) {
        const result = await super.addNewPaymentLine(paymentMethod);

        if (this._isMercadoPagoPayment(paymentMethod)) {
            // New payment line - ensure state is reset
            const order = this.currentOrder;
            const line = this.selectedPaymentLine;
            if (order && line) {
                const orderUid = order.uid;
                const lineUuid = line.uuid;
                
                if (this.mpState.currentOrderUid !== orderUid || 
                    this.mpState.currentPaymentLineUuid !== lineUuid) {
                    // Different order or payment line - reset state
                    this._resetMPState();
                    this.mpState.currentOrderUid = orderUid;
                    this.mpState.currentPaymentLineUuid = lineUuid;
                }
            }
            this.showMPQRPopup();
        }
        return result;
    },

    async deletePaymentLine(uuid) {
        const line = this.paymentLines.find((l) => l.uuid === uuid);
        
        if (line && line.payment_method_id && this._isMercadoPagoPayment(line.payment_method_id)) {
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
    
    _resetMPState() {
        // STOP POLLING FIRST - critical to prevent old polling from continuing
        this.mpState.pollActive = false;
        
        // Clear auto-navigation timer if it exists
        if (this.autoNavigateTimer) {
            clearTimeout(this.autoNavigateTimer);
            this.autoNavigateTimer = null;
        }
        
        // Clear payment identifiers BEFORE other fields
        // This ensures polling checks fail immediately if they're still running
        this.mpState.payment_id = null;
        this.mpState.external_reference = null;
        
        // Then reset other state
        this.mpState.status = "idle";
        this.mpState.error = null;
        this.mpState.qr_url = null;
    },
    
    showMPQRPopup() {
        const order = this.currentOrder;
        const line = this.selectedPaymentLine;
        
        if (!order || !line) {
            return;
        }
        
        const orderUid = order.uid;
        const lineUuid = line.uuid;
        
        // Check if order or payment line changed - reset completely if so
        if (this.mpState.currentOrderUid !== orderUid || 
            this.mpState.currentPaymentLineUuid !== lineUuid) {
            // New order or payment line - reset completely
            this._resetMPState();
            this.mpState.currentOrderUid = orderUid;
            this.mpState.currentPaymentLineUuid = lineUuid;
        }
        
        this.mpState.visible = true;
        
        // Reset state only if not already pending
        if (this.mpState.status !== 'pending') {
            this.mpState.status = "loading";
            this.mpState.error = null;
            this.mpState.qr_url = null;
            this.mpState.external_reference = null;
            
            // Automatically start QR generation
            setTimeout(() => this.startMercadoPago(), 100);
        }
    },
    
    _getMPAmount() {
        const line = this.selectedPaymentLine;
        if (line && line.payment_method_id && this._isMercadoPagoPayment(line.payment_method_id)) {
            return line.amount || 0;
        }
        // Fallback to order due amount
        const order = this.currentOrder;
        return order ? order.get_due() : 0;
    },

    hideMPQRPopup() {
        // Stop polling when hiding
        this.mpState.pollActive = false;
        
        // Clear auto-navigation timer if it exists
        if (this.autoNavigateTimer) {
            clearTimeout(this.autoNavigateTimer);
            this.autoNavigateTimer = null;
        }
        
        this.mpState.visible = false;
    },

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

    
    _handleMPRetry() {
        this.mpState.status = "loading";
        this.mpState.error = null;
        this.mpState.qr_url = null;
        
        setTimeout(() => this.startMercadoPago(), 100);
    },

    _handleMPClose() {
        this.hideMPQRPopup();
    },

    async _handleMPCancel() {
        this.mpState.pollActive = false;
        
        // Clear auto-navigation timer if it exists
        if (this.autoNavigateTimer) {
            clearTimeout(this.autoNavigateTimer);
            this.autoNavigateTimer = null;
        }
        
        const line = this.selectedPaymentLine;
        const lineUuid = line ? line.uuid : null;
        
        if (this.mpState.payment_id) {
            try {
                await this.mpOrm.call(
                    "pos.payment.method",
                    "cancel_mp_payment",
                    [],
                    { payment_id: this.mpState.payment_id }
                );
            } catch (e) {
                this.mpNotification.add(
                    `Error al cancelar pago: ${e.message || e}`,
                    { type: "danger", title: "Error" }
                );
            }
        }
        
        // Reset state completely
        this._resetMPState();
        this.hideMPQRPopup();
        
        if (lineUuid) {
            try {
                await super.deletePaymentLine(lineUuid);
            } catch (e) {
                this.mpNotification.add(
                    `Error al eliminar línea: ${e.message || e}`,
                    { type: "danger", title: "Error" }
                );
            }
        }
        
        this.mpNotification.add(
            "Pago cancelado",
            { type: "info" }
        );
    },

    async _handleMPNewOrder() {
        // Reset state completely for new order
        this._resetMPState();
        this.hideMPQRPopup();
        
        try {
            await this.validateOrder(false);
        } catch (e) {
            this.mpNotification.add(
                `Error al validar orden: ${e.message || e}`,
                { type: "danger", title: "Error" }
            );
        }
    },

    
    async startMercadoPago() {
        const order = this.currentOrder;
        const line = this.selectedPaymentLine; 

        if (!line) {
            this.mpState.status = "error";
            this.mpState.error = "No hay línea de pago seleccionada";
            return;
        }

        const amount = this._getMPAmount();
        
        if (!amount || amount <= 0) {
            this.mpState.status = "error";
            this.mpState.error = "El monto debe ser mayor a 0";
            return;
        }

        this.mpState.status = "loading";
        this.mpState.error = null;

        try {
            const partner = order.get_partner();
            const customerEmail = partner && partner.email ? partner.email : null;
            
            const res = await this.mpOrm.call(
                "pos.payment.method", 
                "create_mp_payment", 
                [], 
                {
                    amount: amount,
                    description: order.name,
                    pos_client_ref: order.name,
                    payment_method_id: line.payment_method_id.id,
                    customer_email: customerEmail,
                }
            );

            if (res.status !== "success") {
                this.mpState.status = "error";
                this.mpState.error = res.details || "Error al crear el pago";
                return;
            }

            this.mpState.status = "pending";
            this.mpState.qr_url = res.qr_data;
            this.mpState.payment_id = res.payment_id;
            this.mpState.external_reference = order.name;  // Store external reference for accurate status checking
            this.mpState.pollActive = true;
            
            this._pollPaymentStatus();

        } catch (err) {
            this.mpState.status = "error";
            this.mpState.error = err.message || "Error de conexión con MercadoPago";
        }
    },

    async _pollPaymentStatus() {
        // Validate we're still polling the correct payment
        const order = this.currentOrder;
        const line = this.selectedPaymentLine;
        
        // Basic checks first
        if (!this.mpState.payment_id || !this.mpState.visible || !this.mpState.pollActive) {
            return;
        }
        
        // Verify order and payment line still exist
        if (!order || !line) {
            this.mpState.pollActive = false;
            return;
        }
        
        // CRITICAL: Verify order/payment line hasn't changed
        // This prevents polling from continuing with old payment_id after state reset
        if (this.mpState.currentOrderUid !== order.uid || 
            this.mpState.currentPaymentLineUuid !== line.uuid) {
            // Order/payment line changed - stop polling immediately
            this.mpState.pollActive = false;
            return;
        }
        
        // Verify payment_id is still valid (shouldn't be null after above checks, but double-check)
        if (!this.mpState.payment_id) {
            this.mpState.pollActive = false;
            return;
        }

        try {
            const res = await this.mpOrm.call(
                "pos.payment.method",
                "check_mp_status",
                [],
                { 
                    payment_id: this.mpState.payment_id,
                    external_reference: this.mpState.external_reference
                }
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
                
                // Set timer to auto-navigate to new order after 3 seconds
                // Store current order/payment line to verify they haven't changed
                const currentOrderUid = order ? order.uid : null;
                const currentLineUuid = line ? line.uuid : null;
                
                // Clear any existing timer first
                if (this.autoNavigateTimer) {
                    clearTimeout(this.autoNavigateTimer);
                }
                
                this.autoNavigateTimer = setTimeout(() => {
                    // Verify order and payment line haven't changed before navigating
                    const currentOrder = this.currentOrder;
                    const currentLine = this.selectedPaymentLine;
                    
                    if (currentOrder && currentLine &&
                        currentOrder.uid === currentOrderUid &&
                        currentLine.uuid === currentLineUuid &&
                        this.mpState.status === "approved") {
                        this._handleMPNewOrder();
                    }
                    
                    this.autoNavigateTimer = null;
                }, 3000);
                
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

            // Unknown status - keep trying
            if (this.mpState.pollActive) {
                setTimeout(() => this._pollPaymentStatus(), 3000);
            }

        } catch (e) {
            // On network error, retry after a longer delay
            if (this.mpState.pollActive) {
                setTimeout(() => this._pollPaymentStatus(), 5000);
            }
        }
    },
});
