export async function sendVerificationEmail(
  apiKey: string,
  toEmail: string,
  toName: string,
  verificationUrl: string
) {
  const url = 'https://api.brevo.com/v3/smtp/email'
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
      <h2 style="color: #333;">Bem-vindo à Transfer Neves!</h2>
      <p style="color: #555; line-height: 1.5;">Olá <strong>${toName}</strong>,</p>
      <p style="color: #555; line-height: 1.5;">Obrigado por se cadastrar como motorista. Para ativar sua conta e começar a receber corridas, por favor confirme seu endereço de e-mail clicando no botão abaixo:</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${verificationUrl}" style="background-color: #007bff; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 4px; font-weight: bold; display: inline-block;">Confirmar meu e-mail</a>
      </div>
      <p style="color: #555; line-height: 1.5;">Ou copie e cole o link abaixo no seu navegador:</p>
      <p style="word-break: break-all; color: #007bff;">${verificationUrl}</p>
      <hr style="border: none; border-top: 1px solid #eaeaea; margin: 30px 0;" />
      <p style="color: #999; font-size: 12px;">Se você não solicitou este cadastro, pode ignorar este e-mail com segurança.</p>
    </div>
  `

  const payload = {
    sender: { name: 'Transfer Neves', email: 'TransferNeves@viftec.com' }, // Update with real sender if needed
    to: [{ email: toEmail, name: toName }],
    subject: 'Transfer Neves - Confirme seu e-mail de motorista',
    htmlContent,
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('Brevo API Error:', errorText)
    throw new Error(`Failed to send email via Brevo: ${response.status}`)
  }

  return response.json()
}

export async function sendPasswordResetEmail(
  apiKey: string,
  toEmail: string,
  toName: string,
  resetUrl: string
) {
  const url = 'https://api.brevo.com/v3/smtp/email'
  const htmlContent = `
    <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px; border: 1px solid #eaeaea; border-radius: 8px;">
      <h2 style="color: #333;">Recuperação de Senha</h2>
      <p style="color: #555; line-height: 1.5;">Olá <strong>${toName}</strong>,</p>
      <p style="color: #555; line-height: 1.5;">Recebemos um pedido para redefinir a senha da sua conta Transfer Neves. Se foi você, clique no botão abaixo para criar uma nova senha:</p>
      <div style="text-align: center; margin: 30px 0;">
        <a href="${resetUrl}" style="background-color: #007bff; color: #ffffff; text-decoration: none; padding: 12px 24px; border-radius: 4px; font-weight: bold; display: inline-block;">Redefinir minha senha</a>
      </div>
      <p style="color: #555; line-height: 1.5;">Ou copie e cole o link abaixo no seu navegador:</p>
      <p style="word-break: break-all; color: #007bff;">${resetUrl}</p>
      <p style="color: #555; line-height: 1.5; margin-top: 20px;"><strong>Atenção:</strong> Este link expira em 2 horas.</p>
      <hr style="border: none; border-top: 1px solid #eaeaea; margin: 30px 0;" />
      <p style="color: #999; font-size: 12px;">Se você não solicitou a troca de senha, pode ignorar este e-mail com segurança. Sua conta continua protegida.</p>
    </div>
  `

  const payload = {
    sender: { name: 'Transfer Neves', email: 'TransferNeves@viftec.com' },
    to: [{ email: toEmail, name: toName }],
    subject: 'Transfer Neves - Recuperação de Senha',
    htmlContent,
  }

  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'api-key': apiKey,
      'Content-Type': 'application/json',
      'Accept': 'application/json',
    },
    body: JSON.stringify(payload),
  })

  if (!response.ok) {
    const errorText = await response.text()
    console.error('Brevo API Error:', errorText)
    throw new Error(`Failed to send email via Brevo: ${response.status}`)
  }

  return response.json()
}
