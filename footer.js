(() => {
  const footer = document.querySelector('.titi-footer');
  if (!footer) return;

  const button = footer.querySelector('.titi-footer__copy');
  const email = footer.querySelector('.titi-footer__email');
  const status = footer.querySelector('.titi-footer__status');
  if (!button || !email || !status || !navigator.clipboard?.writeText) return;

  const messages = document.documentElement.lang.toLowerCase().startsWith('en')
    ? {
      copy: 'Copy', copied: 'Copied',
      copying: 'Copying email address…',
      success: 'Email address copied.',
      error: 'Could not copy. Please select and copy the email address above.'
    }
    : {
      copy: '복사', copied: '완료',
      copying: '이메일 주소를 복사하고 있어요.',
      success: '이메일 주소를 복사했어요.',
      error: '복사하지 못했어요. 위 이메일 주소를 직접 선택해 복사해 주세요.'
    };
  const defaultStatus = status.textContent;
  const label = button.querySelector('span');
  const address = email.getAttribute('href').slice('mailto:'.length);
  let resetTimer;
  button.hidden = false;

  button.addEventListener('click', async () => {
    clearTimeout(resetTimer);
    button.disabled = true;
    button.removeAttribute('data-copied');
    label.textContent = messages.copy;
    status.textContent = messages.copying;
    try {
      await navigator.clipboard.writeText(address);
      button.setAttribute('data-copied', '');
      label.textContent = messages.copied;
      status.textContent = messages.success;
      resetTimer = setTimeout(() => {
        button.removeAttribute('data-copied');
        label.textContent = messages.copy;
        status.textContent = defaultStatus;
      }, 4000);
    } catch {
      status.textContent = messages.error;
    } finally {
      button.disabled = false;
    }
  });
})();
