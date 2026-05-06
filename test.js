// Test de connexion aux bases de données
require('dotenv').config();
const { testConnections } = require('./config/database');

async function runTests() {
  console.log('🧪 Test de connexion aux bases de données...\n');
  
  try {
    await testConnections();
    console.log('\n✅ Tous les tests passés ! Le dashboard est prêt.');
    process.exit(0);
  } catch (error) {
    console.error('\n❌ Erreur lors des tests:', error.message);
    process.exit(1);
  }
}

runTests();
