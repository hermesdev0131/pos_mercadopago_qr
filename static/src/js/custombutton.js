/** @odoo-module */
import { ControlButtons } from "@point_of_sale/app/screens/product_screen/control_buttons/control_buttons";
import { InfoPopup } from "@pos_custom_popup/overrides/select_partner_button/info_popup";
import { makeAwaitable } from "@point_of_sale/app/store/make_awaitable_dialog";
import { patch } from "@web/core/utils/patch";
import { _t } from "@web/core/l10n/translation";
patch(ControlButtons.prototype, {
    async onClickPopup() {
        const order = this.pos.get_order();
        const payload = await makeAwaitable(this.dialog, InfoPopup, {
            title: _t("Custom Popup!"),
            order: order,
        });
    }
});
