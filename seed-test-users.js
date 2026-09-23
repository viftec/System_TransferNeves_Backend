const apiUrls = [
  'http://localhost:8787',
  'https://transferneves.contato-propostafacil.workers.dev'
];

async function seed() {
  for (const url of apiUrls) {
    console.log(`\nSeeding environment: ${url}`);
    
    // 1. Create Admin
    const registerRes = await fetch(`${url}/api/auth/register`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        email: 'teste_ad@gmail.com',
        password: '123456',
        name: 'Administrador Teste',
        role: 'admin',
        phone: '11999999999'
      })
    });
    
    if (registerRes.status === 409) {
      console.log('Admin already exists.');
    } else if (!registerRes.ok) {
      console.error('Failed to create admin:', await registerRes.text());
      console.log('Continuing anyway to try login...');
    } else {
      console.log('Admin created successfully.');
    }

    // 2. Login as Admin
    const loginRes = await fetch(`${url}/api/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ email: 'teste_ad@gmail.com', password: '123456' })
    });

    if (!loginRes.ok) {
      console.error('Failed to login as admin:', await loginRes.text());
      continue;
    }
    
    const { token } = await loginRes.json();
    console.log('Admin logged in, token retrieved.');

    // 3. Create Driver using POST /api/drivers
    const createDriverRes = await fetch(`${url}/api/drivers`, {
      method: 'POST',
      headers: { 
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${token}`
      },
      body: JSON.stringify({
        user: {
          email: 'teste_motorista@gmail.com',
          password: '123456',
          name: 'Motorista Teste',
          phone: '11988888888'
        },
        driver: {
          cpf: `123${Math.floor(Math.random()*100000000)}`,
          cnh: `123${Math.floor(Math.random()*100000000)}`,
          cnhExpiry: '2030-01-01',
          street: 'Rua de Teste',
          status: 'approved'
        },
        vehicle: {
          type: 'sedan',
          model: 'Toyota Corolla',
          plate: `ABC-${Math.floor(Math.random()*10000)}`,
          year: 2022,
          color: 'Preto'
        }
      })
    });

    if (!createDriverRes.ok) {
      console.error('Failed to create driver:', await createDriverRes.text());
    } else {
      console.log('Driver created successfully.');
    }
  }
}

seed().catch(console.error);
