/**
 * Receptor de licenças do Mini ERP.
 * Como publicar: abra a planilha de licenças > Extensões > Apps Script > cole este código >
 * Implantar > Nova implantação > tipo "App da Web" > Executar como: Eu > Quem tem acesso: Qualquer pessoa >
 * copie a URL gerada e cole em WEBHOOK_URL no arquivo licenca.py.
 * Colunas: A Nome da Empresa | B CNPJ | C Chave | D Máquina | E Data de ativação
 */
function doPost(e) {
  var lock = LockService.getScriptLock();
  lock.waitLock(20000);
  try {
    var d = JSON.parse(e.postData.contents);
    var sh = SpreadsheetApp.getActiveSpreadsheet().getSheets()[0];
    var dados = sh.getDataRange().getValues();
    for (var i = 1; i < dados.length; i++) {
      if (String(dados[i][1]) === d.cnpj) {
        if (dados[i][3] && String(dados[i][3]) !== d.maquina) {
          return saida({ok: false, erro: 'Esta licença já está ativada em outro computador. Entre em contato com o suporte.'});
        }
        sh.getRange(i + 1, 1, 1, 5).setValues([[d.nome, d.cnpj, d.chave, d.maquina, d.data]]);
        return saida({ok: true});
      }
    }
    sh.appendRow([d.nome, d.cnpj, d.chave, d.maquina, d.data]);
    return saida({ok: true});
  } catch (err) {
    return saida({ok: false, erro: String(err)});
  } finally {
    lock.releaseLock();
  }
}

function saida(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
