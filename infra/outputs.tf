output "api_url" {
  description = "URL of the BIM Convert API"
  value       = "https://${var.domain}"
}

output "api_public_ip" {
  description = "Public IP of the API VM — point your DNS A record here"
  value       = azurerm_public_ip.api.ip_address
}

output "dns_instructions" {
  description = "DNS setup instructions"
  value       = "Create an A record: ${var.domain} → ${azurerm_public_ip.api.ip_address}"
}

output "ssh_command" {
  description = "SSH into the API VM"
  value       = "ssh ${var.admin_username}@${azurerm_public_ip.api.ip_address}"
}

output "worker_vm_name" {
  description = "Worker VM name"
  value       = azurerm_windows_virtual_machine.worker.name
}

output "resource_group_name" {
  description = "Resource group name"
  value       = azurerm_resource_group.main.name
}

output "storage_account_name" {
  description = "Storage account name"
  value       = azurerm_storage_account.main.name
}

output "worker_start_command" {
  description = "Command to manually start the worker VM"
  value       = "az vm start -g ${azurerm_resource_group.main.name} -n ${azurerm_windows_virtual_machine.worker.name}"
}

output "worker_deallocate_command" {
  description = "Command to manually deallocate the worker VM"
  value       = "az vm deallocate -g ${azurerm_resource_group.main.name} -n ${azurerm_windows_virtual_machine.worker.name}"
}

output "view_logs_command" {
  description = "Command to list conversion logs"
  value       = "az storage blob list --account-name ${azurerm_storage_account.main.name} -c logs --output table"
}
