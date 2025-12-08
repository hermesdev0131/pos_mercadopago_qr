/** @odoo-module **/

import { PaymentMethod } from "@point_of_sale/app/models/pos_payment_method";
import { registerPaymentMethod } from "@point_of_sale/app/models/pos_payment_method";

console.log("MercadoPago POS Module Loaded");

export class MercadoPagoPayment extends PaymentMethod {}

registerPaymentMethod("mercadopago", MercadoPagoPayment);
