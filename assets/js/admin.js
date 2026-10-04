(() => {
    'use strict';
    const dialog = document.getElementById('mrs-dtc-delete-dialog');
    if (!dialog) return;
    const idField = document.getElementById('mrs-dtc-delete-id');

    document.querySelectorAll('.mrs-dtc-delete').forEach(button => {
        button.addEventListener('click', () => {
            idField.value = button.dataset.id;
            if (typeof dialog.showModal === 'function') dialog.showModal();
        });
    });
    document.getElementById('mrs-dtc-delete-cancel').addEventListener('click', () => dialog.close());
})();
