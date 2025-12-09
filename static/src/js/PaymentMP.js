/** @odoo-module **/

import { PaymentScreen } from "@point_of_sale/app/screens/payment_screen/payment_screen";
import { patch } from "@web/core/utils/patch";

console.log("MercadoPago POS Module Loaded");

patch(PaymentScreen.prototype, {
  get mp_template_name() {
    const selectedLine = this.currentOrder?.paymentLines?.find(
      (line) => line.selected
    );
    
    if (selectedLine?.payment_method?.name === "MercadoPago") {
      return "MP.PaymentPlaceholder";
    }
    return null;
  },
});
