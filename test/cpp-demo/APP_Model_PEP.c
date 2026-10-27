#include "APP_Model.h"

void APP_Model_SetPEPsOutputs(void)
{
    g_app_model_state = 1u;
    APP_Model_Set29COutputs();
}
