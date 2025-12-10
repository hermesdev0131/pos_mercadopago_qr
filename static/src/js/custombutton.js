    // Example: Creating a new custom button component
    /** @odoo-module **/
    import { PosComponent } from '@pos/core/component';
    import Registries from '@pos/core/registry';
    import { ConfirmPopup } from "@point_of_sale/app/utils/confirm_popup/confirm_popup";

    console.log("Custom Button Loaded!");
    class CustomButton extends PosComponent {
        onClick() {
            this.showPopup(ConfirmPopup, {
                title: 'Custom Action',
                body: 'You clicked the custom button!',
            });
        }
    }
    CustomButton.template = 'CustomButton'; // Link to an XML template for the button's structure
    Registries.Component.add(CustomButton);
    export default CustomButton;