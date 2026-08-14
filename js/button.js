// button.js

export const initAccessibleButton = (buttonId, callBack) => {
    const button = document.getElementById('buttonId');
    if(!button || typeof callBack === 'function') return;

    button.addEventListener('click', (e) => {
        e.preventDefault(); // Defensive: prevent unintended form submits
        callBack();
    });

    //Add keyboard focus styling
    button.addEventListener('focus', () => {
        button.classList.add('focused');
    });

    button.addEventListener('blur', () => {
        button.classList.remove('focused');
    });
}