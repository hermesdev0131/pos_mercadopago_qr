/** @odoo-module **/

import { Component } from "@odoo/owl";
import { registry } from "@web/core/registry";

/**
 * MercadoPago QR Popup Component
 * 
 * A full-screen modal popup for displaying MercadoPago QR codes
 * and handling payment status in Odoo 18 POS.
 *  * 
 * States:
 * - loading: Generating QR code (initial state)
 * - pending: QR code displayed, waiting for customer payment
 * - approved: Payment successful
 * - error: Payment failed or error occurred
 */
export class MPQRPopup extends Component {
    static template = "pos_mercadopago_qr.MPQRPopup";
    
    static props = {
        // Current status of the payment flow
        status: { type: String },
        
        // QR code image URL (base64 or URL)
        qr_url: { type: [String, { value: null }], optional: true },
        
        // Payment amount to display
        amount: { type: [String, Number], optional: true },
        
        // Error message when status is 'error'
        error: { type: [String, { value: null }], optional: true },
        
        // Callback to start the payment process
        onStart: { type: Function },
        
        // Callback to close the popup
        onClose: { type: Function },
        
        // Callback to retry after an error
        onRetry: { type: Function },
        
        // Callback to cancel pending payment (deletes payment line)
        onCancel: { type: Function },
        
        // Callback to start a new order after success
        onNewOrder: { type: Function },
    };
}

// Register component in POS components registry
registry.category("pos_components").add("MPQRPopup", MPQRPopup);

export default MPQRPopup;
