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
        });
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

    
    selectPaymentLine(uuid) {
        super.selectPaymentLine(uuid);

        const line = this.paymentLines.find((l) => l.uuid === uuid);

        if (line && line.payment_method_id && line.payment_method_id.name === "MercadoPago") {
            const status = line.get_payment_status();
            if (status !== 'done' && status !== 'waitingCard') {
                this.showMPQRPopup();
            }
        } else {
            this.hideMPQRPopup();
        }
    },

    
    async addNewPaymentLine(paymentMethod) {
        const result = await super.addNewPaymentLine(paymentMethod);

        if (paymentMethod.name === "MercadoPago") {
            this.showMPQRPopup();
        }
        return result;
    },

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
    
    showMPQRPopup() {
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
        
        this.mpState.status = "idle";
        this.mpState.payment_id = null;
        this.mpState.external_reference = null;
        this.mpState.qr_url = null;
        this.mpState.error = null;
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
        
        if (!this.mpState.payment_id || !this.mpState.visible || !this.mpState.pollActive) {
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
