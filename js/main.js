import { initAccessibleButton } from "./js/button.js";

document.addEventListener('DOMContentLoaded', () => {
    initAccessibleButton(accessibleBtn, () => {
        console.log('button clicked');
    });
});