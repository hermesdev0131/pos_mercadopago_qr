    // Example: Adding CustomButton to ProductScreen
    /** @odoo-module **/
    import { ProductScreen } from "@point_of_sale/app/screens/product_screen/product_screen";
    import CustomButton from './CustomButton'; // Import your custom button component
    import Registries from '@pos/core/registry';

    console.log("Integrate the Button!");
    const ProductScreenWithButton = (ProductScreen) => class extends ProductScreen {
        setup() {
            super.setup();
        }
        get buttons() {
            return [
                ...super.buttons,
                {
                    component: CustomButton,
                    position: 'left', // Or 'right'
                },
            ];
        }
    };
    Registries.Component.extend(ProductScreen, ProductScreenWithButton);