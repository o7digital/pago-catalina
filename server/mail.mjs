import nodemailer from 'nodemailer';

export function createMailer(env = process.env) {
  if (!env.SMTP_HOST || !env.MAIL_FROM) return null;
  const transport = nodemailer.createTransport({
    host: env.SMTP_HOST,
    port: Number(env.SMTP_PORT || 587),
    secure: env.SMTP_SECURE === 'true',
    requireTLS: true,
    tls: { servername: env.SMTP_SERVERNAME || env.SMTP_HOST },
    auth: env.SMTP_USER ? { user: env.SMTP_USER, pass: env.SMTP_PASSWORD } : undefined,
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000
  });
  return {
    verify: () => transport.verify(),
    async sendCode(email, code) {
      const result = await transport.sendMail({
        from: { name: 'Catalina · Acceso privado', address: env.MAIL_FROM },
        to: email,
        subject: 'Tu código de acceso a Catalina',
        text: `Tu código de verificación de Catalina es: ${code}\n\nCaduca en 10 minutos y solo se puede utilizar una vez. No compartas este código. Si no has solicitado el acceso, ignora este mensaje.`
      });
      if (!result.accepted?.length) throw new Error('Email not accepted');
    }
  };
}
