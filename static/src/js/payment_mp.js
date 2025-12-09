/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";

patch(PaymentScreen.prototype, {
    async clickPaymentMethod(paymentMethod) {
        // run original logic
        await super.clickPaymentMethod(paymentMethod);

        if (paymentMethod.name === "MercadoPago") {
            this.openMercadoPagoPopup();
        }
    },

    async openMercadoPagoPopup() {
        const popup = this.popup;

        popup.add("pos_mercadopago_qr.MPQRPopup", {
            title: "Mercado Pago",
            status: "loading",
            qr_url: null,
            error: null,
        });

        // after popup opens, generate QR
        this.generateMercadoPagoQR();
    },

    async generateMercadoPagoQR() {
        try {
            const result = await this.orm.call(
                "pos.payment.method",
                "create_mp_payment",
                [],
                {}
            );

            if (result.status === "success") {
                this.popup.add("pos_mercadopago_qr.MPQRPopup", {
                    status: "pending",
                    qr_url: result.qr_data,
                });
            } else {
                this.popup.add("pos_mercadopago_qr.MPQRPopup", {
                    status: "error",
                    error: result.details,
                });
            }
        } catch (err) {
            this.popup.add("pos_mercadopago_qr.MPQRPopup", {
                status: "error",
                error: "Unexpected error",
            });
        }
    },
});
