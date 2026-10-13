(() => {
  const footer = document.querySelector('.titi-footer');
  if (!footer) return;

  const button = footer.querySelector('.titi-footer__copy');
  const email = footer.querySelector('.titi-footer__email');
  const status = footer.querySelector('.titi-footer__status');
  if (!button || !email || !status || !navigator.clipboard?.writeText) return;

  const defaultStatus = status.textContent;
  const label = button.querySelector('span');
  const address = email.getAttribute('href').slice('mailto:'.length);
  let resetTimer;
  button.hidden = false;

  button.addEventListener('click', async () => {
    clearTimeout(resetTimer);
    button.disabled = true;
    button.removeAttribute('data-copied');
    label.textContent = '복사';
    status.textContent = '이메일 주소를 복사하고 있어요.';
    try {
      await navigator.clipboard.writeText(address);
      button.setAttribute('data-copied', '');
      label.textContent = '완료';
      status.textContent = '이메일 주소를 복사했어요.';
      resetTimer = setTimeout(() => {
        button.removeAttribute('data-copied');
        label.textContent = '복사';
        status.textContent = defaultStatus;
      }, 4000);
    } catch {
      status.textContent = '복사하지 못했어요. 위 이메일 주소를 직접 선택해 복사해 주세요.';
    } finally {
      button.disabled = false;
    }
  });
})();
